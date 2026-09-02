import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import type { Id } from "../../convex/_generated/dataModel";
import { compareCardNumbers } from "@/lib/cards/card-number";
import NeonButton from "../modules/NeonButton";
import { deriveCardAttention } from "./card-attention";
import {
  AttentionSportContext,
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
 * The walker owns the queue, the chrome, the progress line, Skip and Close.
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
  /** Escape, the Close button, and the all-clear step all end here. Nothing is lost. */
  onClose: () => void;
  /**
   * a11y: the durable control this was opened from. The walker can open
   * automatically after a commit, across an async gap from whatever the
   * operator last touched, so its own activeElement-at-mount capture cannot be
   * trusted — same reasoning as SyncReviewModal's prop of the same name.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}) {
  // Mount-scoped session state. CardChecklist mounts this only while it is
  // open, so a fresh sitting starts with fresh state and there is no reset to
  // perform — which is why there is no isOpen-watching effect here.
  //
  //  - `skipped`  — deferred this sitting. NOT a write: the card keeps its
  //                 badge in the grid and comes back next time.
  //  - `answered` — a fixer's write for this card landed. Needed as well as
  //                 the derived rule because the write and the subscription
  //                 update are not the same instant, and without it the card
  //                 would flash back on screen in between.
  //  - `fixed`    — how many landed this sitting, for the progress line.
  const [skipped, setSkipped] = useState<Set<string>>(() => new Set());
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const [fixed, setFixed] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  const attentionCards = useMemo(
    () =>
      cards
        .filter((c) => deriveCardAttention(c).length > 0)
        .sort((a, b) => compareCardNumbers(a.cardNumber, b.cardNumber)),
    [cards],
  );

  const remaining = useMemo(
    () =>
      attentionCards.filter(
        (c) => !skipped.has(c._id as string) && !answered.has(c._id as string),
      ),
    [attentionCards, skipped, answered],
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
  const [pinnedId, setPinnedId] = useState<string | null>(() => {
    const first = cards.find((c) => deriveCardAttention(c).length > 0);
    return first ? (first._id as string) : null;
  });

  const current =
    remaining.find((c) => (c._id as string) === pinnedId) ?? remaining[0] ?? null;

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

  if (!isOpen) return null;

  const items = current ? deriveCardAttention(current) : [];
  // The FIRST item whose kind is registered — not simply items[0]. A card
  // flagged for a kind this bundle does not know about plus one it does must
  // still be fixable for the one it does.
  const { item: primaryItem, Fixer } = pickAttentionFixer(items);

  const skipCurrent = () => {
    if (!current) return;
    const cardId = current._id as string;
    movePinPast(cardId);
    setSkipped((prev) => new Set(prev).add(cardId));
  };

  /** A fixer's write landed. Count it and leave the card behind. */
  const markAnswered = (cardId: string) => {
    movePinPast(cardId);
    setAnswered((prev) => new Set(prev).add(cardId));
    setFixed((n) => n + 1);
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
        <div className="flex w-full max-w-md flex-col rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
          <div className="border-b border-gray-700 px-6 py-4">
            <h2
              id="card-attention-walker-title"
              className="text-lg font-semibold text-gray-100"
            >
              Cards Needing Attention
            </h2>
            {/*
              role="status" with no explicit aria-live, per
              accessibility-auditor/live-region-role-pattern.md — the role
              already implies a polite live region, and this line never
              switches to role="alert" (a failed write is announced by the
              fixer's own alert region), so it needs neither the aria-live
              override nor the key-remount that pattern prescribes for regions
              that DO switch roles.
            */}
            <p className="mt-0.5 text-xs text-gray-400" role="status">
              {remaining.length} {remaining.length === 1 ? "card needs" : "cards need"}{" "}
              attention · {fixed} fixed
            </p>
          </div>

          {/*
            A reserved minimum height, for the reason NEO-110 documents on
            EntityReviewWizard: the overlay centres this dialog, so a body that
            changes height moves the footer by HALF the delta, and a click
            aimed at Skip can land on whatever rendered into those coordinates
            instead. The body here swaps between a fixer (~250px), the
            all-clear line (~20px) and the no-fixer notice, so the reservation
            is what keeps Skip and Close still.
          */}
          <div className="min-h-80 max-h-[70vh] space-y-4 overflow-y-auto p-6">
            {current && Fixer ? (
              <AttentionSportContext.Provider value={sportId}>
                <Fixer
                  // Remount per card: that is what makes the fixer's
                  // mount-time focus equal "focus the new card's first
                  // control", so focus is never stranded on a control
                  // belonging to the card just answered (the NEO-189
                  // stranding finding).
                  key={current._id as string}
                  row={current}
                  items={items}
                  onSaved={() => markAnswered(current._id as string)}
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
              <p className="text-sm text-gray-200">
                All clear — nothing on this checklist needs attention.
              </p>
            )}
          </div>

          <div className="flex items-center justify-between gap-3 border-t border-gray-700 px-6 py-4">
            <div>
              {current && (
                <button
                  type="button"
                  onClick={skipCurrent}
                  aria-label={`Skip card ${current.cardNumber} for now`}
                  className="text-xs text-gray-400 underline decoration-dotted focus:text-[#00B7FF] focus:outline-none hover:text-[#00B7FF]"
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
