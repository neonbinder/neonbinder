import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import type { Id } from "../../convex/_generated/dataModel";
import { compareCardNumbers } from "@/lib/cards/card-number";
import NeonButton from "../modules/NeonButton";
import { deriveCardAttention, walkDoneLine } from "./card-attention";
import WizardChrome from "./WizardChrome";
import {
  AttentionSportContext,
  attentionWalkRank,
  attentionWalkSubtitle,
  isAwaitingTeamLookup,
  pickAttentionFixer,
  unfixableReason,
  type CardChecklistRow,
} from "./cardAttentionRegistry";

// Re-exported so the registry surface is reachable from the walker too, per
// the locked contract's "export it from CardAttentionWalker.tsx (or a sibling
// cardAttentionRegistry.ts)". The sibling module is the canonical home.
export {
  attentionFixers,
  pickAttentionFixer,
  AttentionSportContext,
  type AttentionFixer,
  type AttentionFixerProps,
  type CardChecklistRow,
} from "./cardAttentionRegistry";

// NEO-339: `walkDoneLine` lives in the pure `card-attention.ts` so the set-build
// tool can say the walker's own sentence; re-exported for existing importers.
export { walkDoneLine } from "./card-attention";

/**
 * NEO-335 Phase 2 (D9) — "Step x of y" for the walker.
 *
 * - `seen` is every card that has been in the walk at any point this sitting.
 *   It only grows, so y never shrinks: a card answered here, skipped, or
 *   resolved somewhere else (a lookup landing, another tab) still counts as
 *   walked. A card flagged mid-sitting joins it and y grows by one.
 * - `left` is how many are still to be asked, the card on screen included.
 * - With a card on screen, x is the walked count plus one. Once nothing is left
 *   the counter reads y of y and the rail is full.
 */
export function walkStep(
  seen: number,
  left: number,
  onScreen: boolean,
): { step: number; total: number } {
  const total = Math.max(seen, left);
  const walked = total - left;
  return { step: onScreen ? Math.min(total, walked + 1) : total, total };
}

/**
 * NEO-102 — walk the cards that need attention, one at a time, after the
 * commit rather than during it.
 *
 * ## Why after
 *
 * "This card has no team" is not knowable at review time: the background BSC
 * team pass runs after the commit, and until it has run, an empty
 * `teamOnCardIds` means "nobody has looked yet", not "there is no team". So
 * the question belongs to the STORED rows, and asking it here means the same
 * dialog also answers it for cards that were committed months ago and never
 * asked — which is the actual bug (10 such cards in dev's 2026 Topps base,
 * every one a League Leaders multi-player card).
 *
 * "After the commit" is about when the question becomes ANSWERABLE, not about
 * this dialog appearing on its own — it never does. `CardChecklist` mounts it
 * only when the operator presses its one control, the amber "N need you" pill
 * in the checklist header (NEO-335). An earlier revision opened it
 * automatically inside a grace window after a commit; that put a
 * `fixed inset-0` overlay over whatever the operator did next, and it is gone.
 *
 * ## A safety net (NEO-335 Phase 2)
 *
 * Teams and titles are now answered in the entity review wizard before a
 * save, so what reaches this walk is what that could not settle: a team
 * lookup that failed, a review the operator cancelled, an edit made since, a
 * set saved before the wizard asked. It wears the wizard's chrome
 * (`WizardChrome`): "Tidy up this set", ONE "Step x of y" across every card
 * the sitting walks (`walkStep`), and the question's type as the subtitle
 * (`attentionWalkSubtitle`). No per-kind counts anywhere.
 *
 * ## The order (NEO-335)
 *
 * Missing players first (NEO-339), then missing teams, then names not yet
 * linked, then titles; by card number within each (`attentionWalkRank`). A
 * team is the question most cards share and the one an operator answers
 * fastest; a player goes ahead of it because the team question's chips come
 * from the card's players. A card that needs both is asked for its player,
 * then comes back in the teams group (see `answered`).
 *
 * ## The queue is derived, not held
 *
 * There is no queue array in state. The presented card is
 *
 *   `remaining.find(pinnedId) ?? remaining[0]`
 *
 * over a list derived from the live `cards` prop:
 *
 *  - **The database is the queue.** `remaining` is `cards` filtered by
 *    `deriveCardAttention` — the same rule the grid badges with — so the
 *    walker can never disagree with what is stored. Fixing a card removes it
 *    because the ROW changed, not because anything called "next".
 *  - **The list changing under you does not move you.** The BSC team pass
 *    keeps flagging rows for a while after a commit, sometimes with a LOWER
 *    card number than the one being answered. `pinnedId` is what keeps the
 *    operator on the card they are reading instead of yanking them to the new
 *    `remaining[0]`. It is seeded at mount and moved only by the two handlers
 *    that leave a card behind, so no effect ever has to chase the derived
 *    list.
 *  - **Skip is not a write.** The card goes into `skipped` for this session
 *    only, so it leaves `remaining` but keeps its badge in the grid and comes
 *    back the next time the walker opens.
 *  - **A landed write is remembered too** (`answered`), because the write and
 *    the subscription update are not the same instant and the card would
 *    otherwise flash back on screen in between.
 *
 * ## Extensibility
 *
 * The walker owns the queue, the chrome and its counter, Skip and Close.
 * Everything card-specific comes from `cardAttentionRegistry.ts`, keyed on
 * `AttentionItem["kind"]`, so NEO-101's title fixer is a registry entry and a
 * component — no change here. A kind with no registered fixer renders no
 * fixer body and leaves Skip available, rather than crashing the dialog.
 *
 * Chrome (portal + nested Radix `Theme`, the Tab trap, `restoreFocusRef`) is
 * lifted from `sync-review-modal.tsx` so all three checklist dialogs behave
 * identically; see the notes there for why each piece exists.
 */
export default function CardAttentionWalker({
  isOpen,
  cards,
  sportId,
  contextOptionId,
  onClose,
  restoreFocusRef,
}: {
  isOpen: boolean;
  /**
   * The set's live `getCardChecklist` rows — ALL of them, not a pre-filtered
   * list. The walker derives its own queue so it stays correct as rows change
   * under it.
   */
  cards: CardChecklistRow[];
  /** NEO-96: the sport-level selectorOptions row id, from the ancestor chain. */
  sportId?: Id<"selectorOptions">;
  /**
   * NEO-331: the checklist's selectorOptions row, handed to fixers so their
   * team picker can order candidates by the set's league and year.
   */
  contextOptionId?: Id<"selectorOptions">;
  /** Escape, the Close button, and the all-clear step all end here. Nothing is lost. */
  onClose: () => void;
  /**
   * a11y: a durable control to restore focus to on close. The walker is only
   * ever opened by hand, but its trigger does not survive the sitting — the
   * header's "N need you" pill is rendered only while `attentionCount > 0`,
   * so answering the last card unmounts the very element the walker's own
   * activeElement-at-mount capture would restore to. The parent passes something that is always mounted
   * instead — same reasoning as SyncReviewModal's prop of the same name.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  // Mount-scoped session state. CardChecklist mounts this only while it is
  // open, so a fresh sitting starts with fresh state and there is no reset to
  // perform — which is why there is no isOpen-watching effect here.
  //
  //  - `skipped`  — deferred this sitting. NOT a write: the card keeps its
  //                 badge in the grid and comes back next time.
  //  - `answered` — a fixer's write for this card landed, and WHICH question
  //                 it answered. Needed as well as the derived rule because the
  //                 write and the subscription update are not the same
  //                 instant, and without it the card would flash back on
  //                 screen in between. Keyed on the question (NEO-339): a card
  //                 whose row, once updated, asks something ELSE (a player
  //                 linked, now its team) rejoins the walk in that question's
  //                 group, rather than leaving the sitting with the pill still
  //                 counting it.
  //  - `seen`     — every question that has been in the walk this sitting
  //                 (card + kind), for "Step x of y" (see `walkStep`). Only
  //                 ever grows.
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [answered, setAnswered] = useState<ReadonlyMap<string, string>>(() => new Map());
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  // One object per (sport, set) pair, not per render — a fresh literal on the
  // Provider would re-render every consumer on each walker render.
  const setContext = useMemo(
    () => ({ sportId, contextOptionId }),
    [sportId, contextOptionId],
  );

  // NEO-335: walk order, then card number — see `attentionWalkRank`. The rank
  // is computed once per card rather than inside the comparator, and so is the
  // question the card is asked (`pickAttentionFixer`'s item), which `answered`
  // and `seen` key on.
  const attentionEntries = useMemo(
    () =>
      cards
        .map((card) => ({ card, items: deriveCardAttention(card) }))
        .filter(({ items }) => items.length > 0)
        .map(({ card, items }) => ({
          card,
          rank: attentionWalkRank(items),
          asked: pickAttentionFixer(items).item?.kind ?? "",
        }))
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            compareCardNumbers(a.card.cardNumber, b.card.cardNumber),
        ),
    [cards],
  );
  const attentionCards = useMemo(
    () => attentionEntries.map(({ card }) => card),
    [attentionEntries],
  );
  const questionKey = (e: { card: CardChecklistRow; asked: string }) =>
    `${e.card._id as string}:${e.asked}`;

  /*
   * y's memory. Seeded with the walk as it opens, and grown in the render
   * that first sees a newly flagged card — the render-phase update React
   * documents for "information from previous renders", which is what keeps
   * this from being an effect that chases the derived list (one extra render
   * with a stale y) or a ref read during render. Cards are only ever ADDED:
   * one that leaves the list by any route has been walked, and y holds.
   */
  const [seen, setSeen] = useState<ReadonlySet<string>>(
    () => new Set(attentionEntries.map(questionKey)),
  );
  const unseen = attentionEntries.filter((e) => !seen.has(questionKey(e)));
  if (unseen.length > 0) {
    setSeen((prev) => {
      const next = new Set(prev);
      for (const e of unseen) next.add(questionKey(e));
      return next;
    });
  }

  /** Cards the automatic team lookup has yet to answer; for the done line only. */
  const awaitingLookup = useMemo(
    () => cards.filter(isAwaitingTeamLookup).length,
    [cards],
  );

  const remaining = useMemo(
    () =>
      attentionEntries
        .filter(
          ({ card, asked }) =>
            !skipped.has(card._id as string) &&
            answered.get(card._id as string) !== asked,
        )
        .map(({ card }) => card),
    [attentionEntries, skipped, answered],
  );

  /**
   * The pin: which card is on screen.
   *
   * It exists for one case — the background BSC pass keeps flagging rows for a
   * while after a commit, sometimes with a LOWER card number than the one
   * being answered, and following `remaining[0]` would swap the card out from
   * under the operator mid-answer.
   *
   * Seeded at mount and moved only by the two handlers that leave a card
   * behind. That is deliberate: an effect that watched the derived list and
   * set the pin would be a cascading render, and a ref read during render is
   * exactly the "refs are not for rendering" mistake. Advancing does not need
   * either, because a card only ever leaves the queue as the result of
   * something the operator did.
   */
  // Seeded from the ORDERED list, so the walk opens on the card it says comes
  // first rather than on whichever flagged row the subscription listed first.
  const [pinnedId, setPinnedId] = useState<string | null>(
    () => (attentionCards[0]?._id as string | undefined) ?? null,
  );

  const current =
    remaining.find((c) => (c._id as string) === pinnedId) ?? remaining[0] ?? null;

  const items = current ? deriveCardAttention(current) : [];
  // The FIRST item whose kind is registered — not simply items[0]. A card
  // flagged for a kind this bundle does not know about plus one it does must
  // still be fixable for the one it does.
  const { item: primaryItem, Fixer } = pickAttentionFixer(items);

  // `unseen` is counted in too: the render that first sees a card already
  // shows it in y, rather than waiting on the queued `setSeen`.
  const { step, total } = walkStep(
    seen.size + unseen.length,
    remaining.length,
    current !== null,
  );
  // The question's type. Empty once the walk is done: the body's done line is
  // the whole story then, and a subtitle naming the last group would be stale.
  const subtitle = current ? attentionWalkSubtitle(items) : "";

  /** Move the pin past `cardId`, so the next render presents the card after it. */
  const movePinPast = (cardId: string) => {
    const idx = remaining.findIndex((c) => (c._id as string) === cardId);
    const next = idx >= 0 ? remaining[idx + 1] : undefined;
    setPinnedId(next ? (next._id as string) : null);
  };

  // Focus in on open, and back to the opener on close.
  useEffect(() => {
    if (!isOpen) return;
    const restoreTarget = restoreFocusRef?.current;
    triggerRef.current = restoreTarget ?? (document.activeElement as HTMLElement | null);
    // The fixer focuses its own first control; this is the fallback for the
    // all-clear step and for a kind with no fixer, so focus is never left on
    // <body> with a modal open.
    const id = requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        closeBtnRef.current?.focus();
      }
    });
    return () => {
      cancelAnimationFrame(id);
      triggerRef.current?.focus?.();
    };
  }, [isOpen, restoreFocusRef]);

  /**
   * a11y (audit fix) — focus on every ADVANCE, not just on open.
   *
   * A registered fixer remounts per card (`key={current._id}` below) and
   * focuses its own first control on mount, so that half of "focus on every
   * advance" was already covered. The other half was not: the two states
   * that render NO fixer at all — a kind this bundle has no fixer for, and
   * the all-clear step once the last card is answered — mount nothing to
   * grab focus. Whenever ADVANCING INTO one of those states unmounts
   * whatever had focus (a fixer's own control disappearing, or Skip itself
   * disappearing because `current` went to null), the browser blurs straight
   * to `<body>` — the open-effect above only runs once, on `isOpen` becoming
   * true, so it does not catch this. Same class of stranding NEO-189 found
   * on a natively-disabled Confirm button, one level up: the control that
   * had focus disappears mid-session and nothing takes its place.
   *
   * Deliberately guarded on `document.activeElement` actually BEING body
   * (not just "no Fixer this render"), rather than parking unconditionally —
   * Skip-ing from one no-fixer card to another no-fixer card unmounts
   * nothing (the Skip button is the same DOM node across that transition,
   * just its label/handler update), so focus is already exactly where it
   * should be and forcing it onto the dialog container on every such advance
   * would be a gratuitous, un-asked-for focus move away from Skip.
   */
  useEffect(() => {
    if (!isOpen || Fixer) return;
    const id = requestAnimationFrame(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        dialogRef.current?.focus();
      }
    });
    return () => cancelAnimationFrame(id);
  }, [isOpen, Fixer, current?._id]);

  if (!isOpen) return null;

  const skipCurrent = () => {
    if (!current) return;
    const cardId = current._id as string;
    movePinPast(cardId);
    setSkipped((prev) => new Set(prev).add(cardId));
  };

  /**
   * A fixer's write landed. Leave the card behind for the question it answered;
   * it counts as walked. A card that then asks something else comes back in
   * that question's group (see `answered`).
   */
  const markAnswered = (cardId: string, kind: string) => {
    movePinPast(cardId);
    setAnswered((prev) => new Map(prev).set(cardId, kind));
  };

  return createPortal(
    // See BaseSetPicker.tsx / sync-review-modal.tsx for why createPortal needs
    // a nested <Theme> — it escapes the root Theme's CSS scope.
    <Theme>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="card-attention-walker-title"
        // a11y: -1, not a tab stop — this is only a focus-park target for the
        // advance-time effect above (the all-clear step and a kind with no
        // registered fixer both mount no control of their own to grab focus).
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // Escape defers: skips and fixes already made stand, nothing in
            // flight is lost, and every remaining card keeps its badge.
            e.preventDefault();
            onClose();
            return;
          }
          if (e.key !== "Tab") return;
          // Keep Tab inside the dialog — aria-modal="true" promises this.
          const root = dialogRef.current;
          if (!root) return;
          const focusable = root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])',
          );
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }}
      >
        {/*
          NEO-271 — THE WIDTH IS MEASURED OFF AN 80-CHARACTER TITLE, not
          picked off a breakpoint.

          `TitleFixer` edits a field whose budget is counted in CHARACTERS
          (`LISTING_TITLE_MAX` is 80, and `TitleLengthMeter` prints `72/80`
          in the label row directly above the input), so the field has to
          show 80 of them at once. At `max-w-md` it showed about 47, and
          editing the end of a value you cannot see, against a limit measured
          in characters, is guesswork.

          WHICH FONT THE NUMBER IS FROM. This dialog is portalled inside a
          nested Radix `<Theme>`, whose `.radix-themes` rule sets
          `font-family: var(--default-font-family)` — the system-UI stack,
          NOT the app's Lexend, and nothing here overrides it. Tailwind's
          preflight gives form controls `font: inherit`, so the title input
          renders in whatever `system-ui` resolves to on the machine looking
          at it. There is therefore no single font to measure, and this is
          sized off the WIDEST candidate rather than the local one.

          MEASURED with fontTools — summed glyph advances at `text-sm`
          (14px) over a realistic worst-case title (mixed case, spaces, a `#`
          and a card number: "2026 Bowman Chrome Prospects #BCP-100 Wyatt
          Langford Texas Rangers Orange Wave"):

            DejaVu Sans  (system-ui on the Linux CI runner)  8.07 px/char
            Lexend 400   (the app's page font)               7.80 px/char
            Helvetica / Arial                                7.25 px/char
            SF Pro Text  (system-ui on macOS)                6.84 px/char

          Worst case 80 × 8.07 = 646px of text. The input adds `p-1.5` plus
          1px borders (14px) and this body adds `p-6` (48px), so the panel
          needs 646 + 14 + 48 = 708px; 45rem (720px) is the round value above
          it and leaves the input a 658px content box — 81 characters in
          DejaVu Sans, 84 in Lexend, 96 in SF Pro. Do NOT tidy this into a
          `max-w-*` bucket: `max-w-2xl` (672px) is five characters short of
          the budget the meter promises, and `max-w-3xl` overshoots it by
          nothing anyone can read.

          It fits CI's 1024×629 viewport with 272px to spare, and `w-full`
          keeps it viewport-width minus the overlay's `p-4` on a narrow
          window — nothing in here carries a min-width, so it reflows.
        */}
        <div className="flex max-h-full w-full max-w-[45rem] flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
          {/*
            NEO-335 Phase 2 (D9) — the wizard's own header: "Tidy up this
            set", "Step x of y" (a role="status" region, so moving it is
            announced, as the "N cards need attention · K fixed" line it
            replaces was), the question's type as the subtitle, and the neon
            rail as the header's bottom edge. The rail only animates forward
            and never under prefers-reduced-motion — see WizardChrome.
            `<header class="shrink-0">`, so it stays out of the scrolling body.
          */}
          <WizardChrome
            titleId="card-attention-walker-title"
            step={step}
            total={total}
            subtitle={subtitle}
          />

          {/*
            NEO-110 / NEO-271 — THE BODY GROWS WITH ITS CONTENT, FROM A FLOOR,
            UNDER A VIEWPORT CAP.

            The reservation, and why it survives. The overlay CENTRES this
            dialog, so a body that changes height moves the footer by HALF the
            delta, and a click aimed at Skip can land on whatever rendered into
            those coordinates instead (the reason NEO-110 documents on
            EntityReviewWizard). The body here swaps between a fixer, the
            all-clear line (~20px) and the no-fixer notice, so a 20rem floor is
            what keeps Skip and Close still. It is sized as the floor that
            covers the COMMON kinds: all three registered fixers — TitleFixer
            (with its variation field), MissingTeamFixer and
            UnreviewedNameFixer — render under 320px at the width above, since
            widening the dialog took wrapped lines out of every one of them. So
            the ordinary card-to-card transition of a 120-card sitting moves
            nothing at all, and growth past the floor is reserved for a body
            that genuinely has more to show than the common kinds do.

            What changed in NEO-271: the cap moved from `max-h-[70vh]` here to
            `max-h-full` on the panel. `70vh` capped this body at 440px on the
            1024×629 CI viewport while the PANEL had no cap at all — so a
            data-heavy fixer scrolled inside the body, taking its own Save
            button below the fold, while ~140px of viewport went spare above
            and below the dialog. `max-h-full` resolves against the overlay's
            content box (`inset-0` minus its `p-4`), the same idiom
            EntityReviewWizard documents, so the body now gets every pixel that
            is not header or footer and scrolls only when it has nowhere left
            to go. Those two are `shrink-0`, which is what makes the shrinking
            land HERE and keeps the header, the fixer's Save and the
            Skip/Close footer reachable in every state.

            `min(20rem,55vh)` rather than a flat 20rem: below a ~490px-tall
            viewport the flat floor plus header and footer no longer fit
            between the overlay's padding and the footer went off-screen.
            min() is 20rem everywhere it fits (including CI, where 55vh is
            346px, so the measured geometry there is unchanged) and lets the
            FLOOR give way on a short window rather than the Close button.
          */}
          <div className="min-h-[min(20rem,55vh)] space-y-4 overflow-y-auto p-6">
            {current && Fixer ? (
              <AttentionSportContext.Provider value={setContext}>
                <Fixer
                  // Remount per card: that is what makes the fixer's
                  // mount-time focus equal "focus the new card's first
                  // control", so focus is never stranded on a control
                  // belonging to the card just answered (the NEO-189
                  // stranding finding).
                  key={current._id as string}
                  row={current}
                  items={items}
                  onSaved={() =>
                    markAnswered(current._id as string, primaryItem?.kind ?? "")
                  }
                  onSkip={skipCurrent}
                />
              </AttentionSportContext.Provider>
            ) : current && primaryItem ? (
              // A kind this bundle has no fixer for. Renders no fixer body and
              // no controls that could write the wrong thing — Skip below is
              // still available, so the operator is never stuck.
              <p className="text-sm italic text-gray-400">
                {unfixableReason(primaryItem)}
              </p>
            ) : (
              // role="status": the walk ending is news — the fixer that had
              // focus just left — and this is the line that says how it ended.
              <p className="text-sm text-gray-200" role="status">
                {walkDoneLine(awaitingLookup)}
              </p>
            )}
          </div>

          {/* `shrink-0` with the header above: the body is the only elastic
              row, so Skip and Close never compress or leave the viewport. */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-gray-700 px-6 py-4">
            <div>
              {current && (
                <button
                  type="button"
                  onClick={skipCurrent}
                  // a11y (2.5.3 label in name): the visible words come first
                  // and contiguous, then which card — a voice user saying
                  // "Skip for now" matches. py-2 -my-2: a 24px target (2.5.8)
                  // without moving the footer.
                  aria-label={`Skip for now, card ${current.cardNumber}`}
                  className="-my-2 py-2 text-xs text-gray-400 underline decoration-dotted focus:text-[#00C2FF] focus:outline-none hover:text-[#00C2FF]"
                >
                  Skip for now
                </button>
              )}
            </div>
            <NeonButton ref={closeBtnRef} cancel onClick={onClose}>
              {remaining.length === 0 ? "Done (Esc)" : "Close (Esc)"}
            </NeonButton>
          </div>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}
