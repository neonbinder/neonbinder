import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import NeonButton from "../modules/NeonButton";
import type { Id } from "../../convex/_generated/dataModel";

/**
 * NEO-203 phase C — the content-diff review.
 *
 * ## Where this sits, and why it is its own dialog
 *
 *   fetch → CardPairingModal → **SyncReviewModal** → EntityReviewWizard → commit
 *
 * Pairing is an IDENTITY question ("which marketplace row is which NB row").
 * This is an EDITORIAL one ("upstream now says something different about a card
 * you already own — is it right?"). Different mental tasks, so a separate
 * dialog, reusing the pairing modal's chrome (portal + Radix `Theme`, focus
 * trap, collapsible sections, Cancel/Confirm footer) so it does not read as a
 * different application.
 *
 * ## The governing rule
 *
 * NeonBinder owns its card data. A marketplace exists only to link an NB card
 * back to a marketplace for listing. So a re-sync refreshes linkage
 * unconditionally and writes a CONTENT field only where the operator says so —
 * which is what every checkbox on this screen is. Nothing here is destructive
 * by default: unreviewed means not applied, un-ticked means not deleted.
 *
 * ## Escape is a FORWARD skip, not an abort
 *
 * `CardPairingModal`'s Escape aborts the whole sync, and correctly: nothing has
 * been decided there and nothing has been written, so cancelling costs only the
 * fetch. By the time this dialog opens, pairing IS decided, and the defaults on
 * this screen are already the safe answer. So Escape here means "skip reviewing
 * changes and carry on with nothing extra applied" — the pipeline advances,
 * linkage still refreshes, content is left alone and nothing is deleted.
 * Copying the earlier dialog's semantics would throw away a confirmed pairing
 * to avoid an editorial question, which is the wrong trade.
 */

export type SyncDiffField = {
  /** A member of the server's `NB_CONTENT_FIELDS`. */
  name: string;
  /** 1 = trust-critical, 2 = substantive-or-cosmetic. Server-assigned. */
  tier: number;
  oldValue: string;
  newValue: string;
  source: "bsc" | "sportlots" | "both" | "none";
  /**
   * Server-computed: do the two values fold to the same thing under the same
   * name fold `CardPairingModal` uses? A fold-equal change is a reformatting
   * rather than a rewrite.
   */
  foldEqual: boolean;
};

export type SyncDiffCard = {
  /** Index into the confirmed card array the diff was computed from. */
  index: number;
  cardNumber: string;
  cardName: string;
  bucket: "identical" | "formattingOnly" | "contentChanges" | "new";
  existingId?: Id<"cardChecklist">;
  baseVersion?: number;
  fields: SyncDiffField[];
};

export type SyncDiffConflict = {
  index: number;
  cardNumber: string;
  cardName: string;
  bsc: { rowId: Id<"cardChecklist">; cardNumber: string; cardName: string };
  sportlots: { rowId: Id<"cardChecklist">; cardNumber: string; cardName: string };
};

export type SyncDiff = {
  cards: SyncDiffCard[];
  removedUpstream: {
    fullyOrphaned: Array<{
      id: Id<"cardChecklist">;
      cardNumber: string;
      cardName: string;
      sides: Array<"bsc" | "sportlots">;
    }>;
    partialOrphanCount: number;
  };
  conflicts: SyncDiffConflict[];
  collisionInsertCount: number;
  /**
   * How many incoming cards were left unmatched BECAUSE a match key was
   * ambiguous — deliberately NOT how many ambiguous keys exist. See the note
   * where this renders, and `WithheldMatchKeys` in convex/selectorOptions.ts.
   */
  ambiguityBlockedCount: number;
};

/** Which NB row the operator believes a cross-side-conflicted card really is. */
export type ConflictChoice = "bsc" | "sportlots" | "new";

export type SyncReviewResult = {
  /** Card index → the content fields the operator accepted for it. */
  applyFieldsByIndex: Record<number, string[]>;
  /** Card index → the matched row's `lastUpdated` at review time. */
  baseVersionByIndex: Record<number, number>;
  operatorDeleteIds: Array<Id<"cardChecklist">>;
  /** Indices deliberately withheld from this commit — see the conflicts section. */
  heldBackIndices: number[];
  conflictResolutions: Array<{
    index: number;
    cardNumber: string;
    choice: ConflictChoice;
  }>;
};

const FIELD_LABEL: Record<string, string> = {
  cardName: "Card name",
  playerIds: "Players",
  teamOnCardIds: "Team",
  attributes: "Attributes",
  isRookie: "Rookie",
  isRelic: "Relic",
  printRun: "Print run",
  autographType: "Autograph",
  cardVariation: "Variation",
};

/**
 * Which marketplace this card came from.
 *
 * Per-CARD rather than per-field, because the BSC↔SportLots merge happens in
 * `CardPairingModal.mergePair` and does not record which side won each field —
 * a per-field claim would be a guess wearing the authority of a badge. The
 * distinction the operator actually needs is still carried: a SportLots-only
 * card is the one to look at hardest, because SL's ref IS the seller's own free
 * text (NEO-91) and so its "corrections" are the least trustworthy.
 */
const SOURCE_LABEL: Record<SyncDiffField["source"], string> = {
  bsc: "via BSC",
  sportlots: "via SportLots",
  both: "via BSC + SportLots",
  none: "",
};

/**
 * The checkbox map's key. `#` cannot appear in either half - a card index is
 * a number and a field name is an `NB_CONTENT_FIELDS` identifier - so the
 * join is unambiguous.
 */
const fieldKey = (index: number, name: string) => `${index}#${name}`;

/**
 * Does this diff contain anything a human has to look at?
 *
 * Exported because `CardChecklist` asks BEFORE mounting the dialog: a re-sync
 * that changed nothing and orphaned nothing must not put a modal in front of
 * the operator that they can only click through. Same precedent as the
 * `candidateCount === 0` short-circuit that skips the pairing dialog.
 *
 * Conflicts count as reviewable even though the operator cannot resolve them
 * into this commit (see the conflicts section): cards being held back is
 * exactly the kind of thing that must not happen silently.
 */
export function needsSyncReview(diff: SyncDiff): boolean {
  return (
    diff.conflicts.length > 0 ||
    diff.removedUpstream.fullyOrphaned.length > 0 ||
    diff.cards.some(
      (c) => c.bucket === "formattingOnly" || c.bucket === "contentChanges",
    )
  );
}

/**
 * The initial checkbox state, by `fieldKey`.
 *
 * ONE rule: a change is pre-accepted if and only if it FOLDS EQUAL — i.e. it is
 * a reformatting ("Jose" → "José", "Ken Griffey Jr" → "Ken Griffey Jr."), not a
 * rewrite. That is the spec's tier-3 overlay, and it deliberately outranks the
 * field's own tier: a tier-1 field whose change folds equal is still the same
 * statement about the card, so pre-accepting it is safe, and refusing to would
 * make the "200 cards re-capitalised" case unbulk-acceptable for exactly the
 * fields most likely to be re-capitalised.
 *
 * Everything else — every substantive change, on every field — starts
 * UNCHECKED. An operator who closes this dialog without reading it applies
 * nothing, which is the whole ownership rule expressed as a default.
 *
 * Exported for its own test: this seeding IS the safety property.
 */
export function seedCheckedFields(cards: SyncDiffCard[]): Record<string, boolean> {
  const seeded: Record<string, boolean> = {};
  for (const c of cards) {
    for (const f of c.fields) {
      seeded[fieldKey(c.index, f.name)] = f.foldEqual;
    }
  }
  return seeded;
}

/** Split the reviewable cards into the two bulk groups the screen shows. */
export function groupDiffCards(cards: SyncDiffCard[]): {
  formattingOnly: SyncDiffCard[];
  contentChanges: SyncDiffCard[];
  identicalCount: number;
  newCount: number;
} {
  const formattingOnly: SyncDiffCard[] = [];
  const contentChanges: SyncDiffCard[] = [];
  let identicalCount = 0;
  let newCount = 0;
  for (const c of cards) {
    if (c.bucket === "formattingOnly") formattingOnly.push(c);
    else if (c.bucket === "contentChanges") contentChanges.push(c);
    else if (c.bucket === "identical") identicalCount++;
    else newCount++;
  }
  return { formattingOnly, contentChanges, identicalCount, newCount };
}

/** `−`/`+` old-vs-new pair, git-diff shaped, in the app's own palette. */
function FieldDiff({ field }: { field: SyncDiffField }) {
  const em = "—";
  return (
    <div className="font-mono text-xs leading-5 min-w-0">
      <div className="text-[#FF2EB3] break-words">
        {/* The glyph is decoration; "was"/"now" is what AT reads. */}
        <span aria-hidden="true">− </span>
        <span className="sr-only">was </span>
        {field.oldValue || em}
      </div>
      <div className="text-[#00D558] break-words">
        <span aria-hidden="true">+ </span>
        <span className="sr-only">now </span>
        {field.newValue || em}
      </div>
    </div>
  );
}

function CardDiffRow({
  card,
  checked,
  onToggleField,
}: {
  card: SyncDiffCard;
  checked: Record<string, boolean>;
  onToggleField: (index: number, name: string) => void;
}) {
  return (
    <li className="border border-gray-700 rounded p-3 bg-gray-800/40">
      <div className="text-sm text-gray-100 font-medium mb-2">
        #{card.cardNumber} {card.cardName}
      </div>
      <ul className="flex flex-col gap-2">
        {card.fields.map((f) => {
          const id = `sync-field-${card.index}-${f.name}`;
          const isChecked = checked[fieldKey(card.index, f.name)] ?? false;
          return (
            <li key={f.name} className="flex items-start gap-3">
              <input
                id={id}
                type="checkbox"
                checked={isChecked}
                onChange={() => onToggleField(card.index, f.name)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[#00D558]"
                // The visible label is the field name; the accessible name has
                // to carry the card too, or a screen-reader user hears "Card
                // name" nine times with nothing to tell them apart (WCAG 2.4.6).
                aria-label={`Apply ${
                  FIELD_LABEL[f.name] ?? f.name
                } to #${card.cardNumber} ${card.cardName}: ${
                  f.oldValue || "empty"
                } becomes ${f.newValue || "empty"}`}
              />
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={id}
                  className="flex flex-wrap items-center gap-2 text-xs text-gray-300 cursor-pointer"
                >
                  <span className="font-semibold">
                    {FIELD_LABEL[f.name] ?? f.name}
                  </span>
                  {f.tier === 1 && (
                    <span
                      // a11y: pink-on-pink here needs a LOWER fill opacity, not
                      // higher — text and background share a hue, so raising
                      // the tint drags the background toward the text color
                      // and contrast falls. /20 measured 3.99:1 against this
                      // row's actual (composited) background — fails WCAG
                      // 1.4.3's 4.5:1 for this text-xs badge, on exactly the
                      // label the tier exists to make someone stop and read.
                      // /10 measures 4.55:1.
                      className="rounded px-1.5 py-0.5 bg-[#FF2EB3]/10 text-[#FF2EB3]"
                      // Not decoration: "check this one deliberately" is the
                      // entire point of the tier.
                    >
                      needs review
                    </span>
                  )}
                  {f.foldEqual && (
                    <span className="rounded px-1.5 py-0.5 bg-gray-700 text-gray-300">
                      formatting
                    </span>
                  )}
                  {SOURCE_LABEL[f.source] && (
                    <span className="rounded px-1.5 py-0.5 bg-[#00B7FF]/15 text-[#00B7FF]">
                      {SOURCE_LABEL[f.source]}
                    </span>
                  )}
                </label>
                <FieldDiff field={f} />
              </div>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export default function SyncReviewModal({
  isOpen,
  diff,
  setLabel,
  saving,
  restoreFocusRef,
  onSkip,
  onConfirm,
}: {
  isOpen: boolean;
  diff: SyncDiff;
  /** e.g. "Dugout Collection Artist's Proofs" — names the set in the heading. */
  setLabel?: string;
  /** The pipeline is already working; the footer buttons lock. */
  saving?: boolean;
  /**
   * a11y: where to send keyboard focus when this dialog closes, PREFERRED
   * over this component's own `document.activeElement`-at-mount capture.
   *
   * That capture is the right default when this modal is opened directly
   * from a click (nothing async in between — `document.activeElement` at
   * mount really is the trigger). It is NOT reliable for this modal
   * specifically: its one real caller (`CardChecklist`) mounts it only after
   * unmounting `CardPairingModal` and then `await`ing a Convex query, so by
   * the time this component's own mount effect runs, whatever was focused
   * before that async gap has already reverted to `<body>` — capturing that
   * would "restore" focus to nowhere. A caller that knows its own durable
   * trigger (e.g. the button that started the whole pipeline) can hand it
   * over here instead. Optional and additive: every existing caller/test that
   * omits it keeps the exact original mount-time-capture behavior.
   */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /**
   * Escape, or the footer's "Skip". Advances the pipeline applying NOTHING
   * extra — NOT an abort of the sync.
   */
  onSkip: () => void;
  onConfirm: (result: SyncReviewResult) => void;
}) {
  const groups = useMemo(() => groupDiffCards(diff.cards), [diff.cards]);

  const [checked, setChecked] = useState<Record<string, boolean>>(() =>
    seedCheckedFields(diff.cards),
  );
  const [deleteIds, setDeleteIds] = useState<Record<string, boolean>>({});
  const [conflictChoice, setConflictChoice] = useState<
    Record<number, ConflictChoice>
  >(() => Object.fromEntries(diff.conflicts.map((c) => [c.index, "new"])));
  // Collapsed by default — the whole point of the split is that 200
  // re-capitalisations do not bury the six changes that matter.
  const [formattingCollapsed, setFormattingCollapsed] = useState(true);
  const [confirmingDeletes, setConfirmingDeletes] = useState(false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const skipBtnRef = useRef<HTMLButtonElement | null>(null);
  const confirmDialogRef = useRef<HTMLDivElement | null>(null);
  const confirmCancelRef = useRef<HTMLButtonElement | null>(null);
  // a11y: the control the delete-confirm was opened FROM. Backing out of the
  // confirm (Cancel, or Escape) unmounts the confirm's own DOM but leaves the
  // review dialog open — nothing then moves focus back to Apply & Continue,
  // so the browser drops it to <body> the instant the focused Cancel button
  // is removed. Same failure shape documented for this codebase's shared
  // busy-flag pattern; the fix here is the same idea, just triggered by a
  // conditional unmount instead of a `disabled` flip.
  const applyBtnRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    // a11y: prefer the caller's durable trigger (see restoreFocusRef's own
    // doc comment) over document.activeElement — falls back to the original
    // capture-on-mount behavior whenever the prop is absent, so every caller
    // that does not pass it keeps working exactly as before. Captured into a
    // local rather than read again in the cleanup: restoreFocusRef.current
    // is a plain DOM ref (React does not clear it out from under an effect
    // the way it would a ref callback), and reading it once keeps this an
    // ordinary mount/unmount pairing.
    const restoreTarget = restoreFocusRef?.current;
    triggerRef.current =
      restoreTarget ?? (document.activeElement as HTMLElement | null);
    const id = requestAnimationFrame(() => skipBtnRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      triggerRef.current?.focus?.();
    };
  }, [isOpen, restoreFocusRef]);

  // Non-destructive by default, every time: focus lands on Cancel, not on the
  // button that deletes rows.
  useEffect(() => {
    if (!confirmingDeletes) return;
    const id = requestAnimationFrame(() => confirmCancelRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [confirmingDeletes]);

  const toggleField = useCallback((index: number, name: string) => {
    setChecked((prev) => {
      const key = fieldKey(index, name);
      return { ...prev, [key]: !prev[key] };
    });
  }, []);

  const formattingFieldKeys = useMemo(
    () =>
      groups.formattingOnly.flatMap((c) =>
        c.fields.map((f) => fieldKey(c.index, f.name)),
      ),
    [groups.formattingOnly],
  );
  const allFormattingAccepted =
    formattingFieldKeys.length > 0 &&
    formattingFieldKeys.every((k) => checked[k]);

  const toggleAllFormatting = useCallback(() => {
    setChecked((prev) => {
      const next = { ...prev };
      const accepting = !formattingFieldKeys.every((k) => prev[k]);
      for (const k of formattingFieldKeys) next[k] = accepting;
      return next;
    });
  }, [formattingFieldKeys]);

  const selectedDeleteIds = useMemo(
    () =>
      diff.removedUpstream.fullyOrphaned
        .filter((r) => deleteIds[r.id as string])
        .map((r) => r.id),
    [diff.removedUpstream.fullyOrphaned, deleteIds],
  );

  const acceptedFieldCount = useMemo(
    () => Object.values(checked).filter(Boolean).length,
    [checked],
  );

  const buildResult = useCallback((): SyncReviewResult => {
    const applyFieldsByIndex: Record<number, string[]> = {};
    const baseVersionByIndex: Record<number, number> = {};
    for (const c of diff.cards) {
      if (c.baseVersion === undefined) continue;
      const accepted = c.fields
        .filter((f) => checked[fieldKey(c.index, f.name)])
        .map((f) => f.name);
      // An empty list is the same statement as no list at all, and the server
      // fails closed on both — so send neither, and keep the wire identical to
      // an unreviewed commit for every untouched card.
      if (accepted.length === 0) continue;
      applyFieldsByIndex[c.index] = accepted;
      baseVersionByIndex[c.index] = c.baseVersion;
    }
    return {
      applyFieldsByIndex,
      baseVersionByIndex,
      operatorDeleteIds: selectedDeleteIds,
      heldBackIndices: diff.conflicts.map((c) => c.index),
      conflictResolutions: diff.conflicts.map((c) => ({
        index: c.index,
        cardNumber: c.cardNumber,
        choice: conflictChoice[c.index] ?? "new",
      })),
    };
  }, [checked, conflictChoice, diff.cards, diff.conflicts, selectedDeleteIds]);

  const submit = useCallback(() => {
    setConfirmingDeletes(false);
    onConfirm(buildResult());
  }, [buildResult, onConfirm]);

  const handleApply = useCallback(() => {
    if (selectedDeleteIds.length > 0) {
      setConfirmingDeletes(true);
      return;
    }
    submit();
  }, [selectedDeleteIds.length, submit]);

  if (!isOpen) return null;

  const orphans = diff.removedUpstream.fullyOrphaned;
  const anyOrphanSelected = selectedDeleteIds.length > 0;
  const allOrphansSelected =
    orphans.length > 0 && selectedDeleteIds.length === orphans.length;

  return createPortal(
    <Theme>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-review-heading"
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // The nested confirm owns its own Escape; it stops propagation, so
            // reaching here means no confirm is open.
            e.stopPropagation();
            onSkip();
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
        <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-4xl max-h-[92vh] flex flex-col">
          <header className="p-4 border-b border-gray-700">
            <h2
              id="sync-review-heading"
              className="text-lg font-semibold text-gray-100"
            >
              Review Changes{setLabel ? ` — ${setLabel}` : ""}
            </h2>
            <p className="text-xs text-gray-400 mt-1">
              NeonBinder owns this checklist. A sync always refreshes the
              marketplace links; it only changes what a card SAYS where you tick
              a box below. Nothing here is applied — or deleted — unless you say
              so.
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {groups.contentChanges.length} card
              {groups.contentChanges.length === 1 ? "" : "s"} with content
              changes · {groups.formattingOnly.length} formatting-only ·{" "}
              {groups.newCount} new · {groups.identicalCount} unchanged
              {orphans.length > 0
                ? ` · ${orphans.length} no longer listed upstream`
                : ""}
            </p>
          </header>

          <div className="flex-1 overflow-y-auto px-4 pb-4 pt-4 flex flex-col gap-5">
            {/* ── Cross-side conflicts ──────────────────────────────────────
                A card whose BSC ref and SportLots ref point at two DIFFERENT
                NB rows. Surfaced rather than resolved silently, on the same
                "surfacing beats narrowing" principle the matching cascade
                itself runs on.

                HONESTY NOTE — read before "fixing" this. The commit contract
                has no target-row override, and inventing a client-supplied row
                id was ruled out by the security audit: the server must decide
                which row an incoming card is, from data the client cannot
                forge. So NO choice here can retarget the write, and the card is
                held back from this commit whichever option is picked. The
                radiogroup records the operator's reading so it can be reported
                back; a follow-up sync matches the card once the duplicate
                linkage upstream is corrected. */}
            {diff.conflicts.length > 0 && (
              <section aria-labelledby="sync-review-conflicts">
                <h3
                  id="sync-review-conflicts"
                  className="text-sm font-semibold text-[#FF2EB3] mb-1"
                >
                  Linked to two cards ({diff.conflicts.length}) — held back from
                  this sync
                </h3>
                <p className="text-xs text-gray-400 mb-2">
                  Each of these is linked by BuySportsCards to one NeonBinder
                  card and by SportLots to a different one. NeonBinder will not
                  write either row while they disagree, so these cards are not
                  saved this time. Record which you believe is right — the next
                  sync matches it once the duplicate link upstream is fixed.
                </p>
                <ul className="flex flex-col gap-2">
                  {diff.conflicts.map((c) => {
                    const chosen = conflictChoice[c.index] ?? "new";
                    const options: Array<{
                      value: ConflictChoice;
                      label: string;
                      detail: string;
                    }> = [
                      {
                        value: "bsc",
                        label: "BSC row",
                        detail: `#${c.bsc.cardNumber} ${c.bsc.cardName}`,
                      },
                      {
                        value: "sportlots",
                        label: "SportLots row",
                        detail: `#${c.sportlots.cardNumber} ${c.sportlots.cardName}`,
                      },
                      {
                        value: "new",
                        label: "Treat as new",
                        detail: "neither — this is its own card",
                      },
                    ];
                    return (
                      <li
                        key={c.index}
                        className="border border-gray-700 rounded p-3 bg-gray-800/40"
                      >
                        <div className="text-sm text-gray-100 font-medium mb-2">
                          #{c.cardNumber} {c.cardName}
                        </div>
                        {/* Same control shape as the pairing modal's
                            nameConflict choice: a real radiogroup with roving
                            tabindex and arrow-key selection, because this is a
                            mutually-exclusive one-of-three, not three toggles. */}
                        <div
                          role="radiogroup"
                          aria-label={`Which NeonBinder card is #${c.cardNumber} ${c.cardName}?`}
                          data-sync-conflict={c.index}
                          className="flex flex-wrap items-center gap-2"
                          onKeyDown={(e) => {
                            if (
                              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                                e.key,
                              )
                            ) {
                              return;
                            }
                            // APG: focus moves WITH selection on a
                            // single-select radiogroup, and wraps at both ends.
                            e.preventDefault();
                            const order = options.map((o) => o.value);
                            const step =
                              e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
                            const at = order.indexOf(chosen);
                            const next =
                              order[(at + step + order.length) % order.length];
                            setConflictChoice((prev) => ({
                              ...prev,
                              [c.index]: next,
                            }));
                            requestAnimationFrame(() => {
                              dialogRef.current
                                ?.querySelector<HTMLElement>(
                                  `[data-sync-conflict="${c.index}"] [role="radio"][tabindex="0"]`,
                                )
                                ?.focus();
                            });
                          }}
                        >
                          {options.map((o) => (
                            <button
                              key={o.value}
                              type="button"
                              role="radio"
                              aria-checked={chosen === o.value}
                              tabIndex={chosen === o.value ? 0 : -1}
                              // Starts with the visible label so speech input
                              // matches what is announced (WCAG 2.5.3).
                              aria-label={`${o.label} — ${o.detail}`}
                              onClick={() =>
                                setConflictChoice((prev) => ({
                                  ...prev,
                                  [c.index]: o.value,
                                }))
                              }
                              className={`text-xs rounded px-2 py-1.5 ${
                                chosen === o.value
                                  ? "bg-cyan-900/60 text-cyan-100 ring-2 ring-[#00B7FF]"
                                  : "bg-gray-700/60 text-gray-300"
                              }`}
                            >
                              {/* A non-colour cue for the state the ring/hue
                                  pair alone would carry (WCAG 1.4.1). */}
                              <span aria-hidden="true">
                                {chosen === o.value ? "✓ " : ""}
                              </span>
                              {o.label}
                              <span className="text-gray-400"> — {o.detail}</span>
                            </button>
                          ))}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* ── Content changes: expanded, reviewed one at a time ───────── */}
            <section aria-labelledby="sync-review-content">
              <h3
                id="sync-review-content"
                className="text-sm font-semibold text-gray-200 mb-2"
              >
                Content changes ({groups.contentChanges.length})
              </h3>
              {groups.contentChanges.length === 0 ? (
                <p className="text-xs text-gray-400">
                  Nothing upstream contradicts what NeonBinder already says.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {groups.contentChanges.map((c) => (
                    <CardDiffRow
                      key={c.index}
                      card={c}
                      checked={checked}
                      onToggleField={toggleField}
                    />
                  ))}
                </ul>
              )}
            </section>

            {/* ── Formatting only: collapsed, one button accepts the lot ──── */}
            {groups.formattingOnly.length > 0 && (
              <section aria-labelledby="sync-review-formatting">
                <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                  {/* a11y: the sibling sections ("Content changes", "Linked to
                      two cards", "No longer listed upstream") all head
                      themselves with a real <h3>, which is what lets a
                      screen-reader user jump section-to-section by heading
                      (NVDA/JAWS "H" key etc). This section's own heading IS
                      interactive (an APG disclosure button), so it gets the
                      same treatment the pattern calls for — a heading
                      WRAPPING the button — rather than dropping out of the
                      heading list entirely. `className="contents"` keeps the
                      <h3> from adding its own box/font-size, so nothing here
                      looks different. */}
                  <h3 className="contents">
                    <button
                      type="button"
                      id="sync-review-formatting"
                      className="text-sm font-semibold text-gray-200"
                      aria-expanded={!formattingCollapsed}
                      // a11y: only meaningful while expanded — the list
                      // unmounts entirely rather than being hidden when
                      // collapsed, so there is nothing to point at at that
                      // point, which is the same "not in the tree" disclosure
                      // behaviour aria-expanded is reporting.
                      aria-controls="sync-review-formatting-list"
                      onClick={() => setFormattingCollapsed((v) => !v)}
                      aria-label={`${
                        formattingCollapsed ? "Expand" : "Collapse"
                      } formatting-only changes, ${groups.formattingOnly.length} cards`}
                    >
                      <span aria-hidden="true">
                        {formattingCollapsed ? "▶" : "▼"}{" "}
                      </span>
                      Formatting only ({groups.formattingOnly.length})
                    </button>
                  </h3>
                  <NeonButton
                    secondary
                    size="1"
                    onClick={toggleAllFormatting}
                    aria-label={
                      allFormattingAccepted
                        ? "Skip all formatting changes"
                        : "Accept all formatting changes"
                    }
                  >
                    {allFormattingAccepted
                      ? "Skip all formatting changes"
                      : "Accept all formatting changes"}
                  </NeonButton>
                </div>
                <p className="text-xs text-gray-400 mb-2">
                  Spelling, capitalisation and accents only — these cards still
                  say the same thing, so they are pre-accepted.
                </p>
                {!formattingCollapsed && (
                  <ul id="sync-review-formatting-list" className="flex flex-col gap-2">
                    {groups.formattingOnly.map((c) => (
                      <CardDiffRow
                        key={c.index}
                        card={c}
                        checked={checked}
                        onToggleField={toggleField}
                      />
                    ))}
                  </ul>
                )}
              </section>
            )}

            {/* ── No longer listed upstream ──────────────────────────────── */}
            {orphans.length > 0 && (
              <section aria-labelledby="sync-review-removed">
                <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                  <h3
                    id="sync-review-removed"
                    className="text-sm font-semibold text-gray-200"
                  >
                    No longer listed upstream ({orphans.length})
                  </h3>
                  {/* Bulk select is scoped to THIS list, which is only the
                      fully-orphaned rows — a card still live on one of its
                      marketplaces never reaches a delete affordance at all. */}
                  <button
                    type="button"
                    className="text-xs text-gray-300 underline"
                    onClick={() =>
                      setDeleteIds(
                        allOrphansSelected
                          ? {}
                          : Object.fromEntries(
                              orphans.map((r) => [r.id as string, true]),
                            ),
                      )
                    }
                    aria-label={
                      allOrphansSelected
                        ? "Clear every delete selection"
                        : `Select all ${orphans.length} cards for deletion`
                    }
                  >
                    {allOrphansSelected ? "Clear all" : "Select all"}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mb-2">
                  Every marketplace this card was linked to answered this sync,
                  and none of them lists it any more. A marketplace dropping a
                  card never deletes it here — these rows keep their NeonBinder
                  data unless you tick them.
                  {diff.removedUpstream.partialOrphanCount > 0 && (
                    <>
                      {" "}
                      {diff.removedUpstream.partialOrphanCount} further row
                      {diff.removedUpstream.partialOrphanCount === 1
                        ? " is"
                        : "s are"}{" "}
                      unaccounted for but still live on at least one marketplace
                      (or contested), so {"they are"} not offered for deletion.
                    </>
                  )}
                </p>
                {/* TODO(NEO-203): the partial orphans above should also carry a
                    per-card chip in the checklist itself (a `ChecklistSourceFilter`
                    `Chip`, per the "removed-upstream" section of
                    .claude/agent-memory/card-collector-tester/neo-203-content-diff-review-spec.md).
                    That needs a persisted per-row orphan marker, which is a
                    schema change and a separate concern from this review. */}
                <ul className="flex flex-col gap-1">
                  {orphans.map((r) => {
                    const id = `sync-delete-${r.id}`;
                    return (
                      <li key={r.id as string} className="flex items-center gap-3">
                        <input
                          id={id}
                          type="checkbox"
                          // ALWAYS unchecked to begin with. Not a style choice:
                          // deletion is the one irreversible action on this
                          // screen.
                          checked={!!deleteIds[r.id as string]}
                          onChange={() =>
                            setDeleteIds((prev) => ({
                              ...prev,
                              [r.id as string]: !prev[r.id as string],
                            }))
                          }
                          className="h-4 w-4 shrink-0 accent-[#FF2EB3]"
                          aria-label={`Delete #${r.cardNumber} ${r.cardName}`}
                        />
                        <label
                          htmlFor={id}
                          className="text-xs text-gray-300 cursor-pointer"
                        >
                          #{r.cardNumber} {r.cardName}
                          <span className="text-gray-400">
                            {" "}
                            — was on{" "}
                            {r.sides
                              .map((s) => (s === "bsc" ? "BSC" : "SportLots"))
                              .join(" + ")}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* Both lines count CARDS, and both are suppressed at zero.
                `ambiguityBlockedCount` used to be a count of ambiguous KEYS,
                which on a variant fanned out across two marketplace series is
                a large number in perfectly healthy data: the 1996 Score
                re-sync announced "110 match keys are held by more than one
                card, so those cards are treated as new" directly above "0
                new". Every card had matched on its ref and the fallback tiers
                were never consulted, so the sentence was false — and false in
                the alarming direction, on exactly the duplicate-numbered sets
                this whole feature exists for. The server now reports how many
                cards ambiguity actually cost a match, so this line appears
                only when it has something to say. */}
            {(diff.collisionInsertCount > 0 ||
              diff.ambiguityBlockedCount > 0) && (
              <p className="text-xs text-gray-400" role="status">
                {diff.collisionInsertCount > 0 &&
                  `${diff.collisionInsertCount} card${
                    diff.collisionInsertCount === 1 ? "" : "s"
                  } will be saved as new rows because another card claimed the same match. `}
                {diff.ambiguityBlockedCount > 0 &&
                  `${diff.ambiguityBlockedCount} card${
                    diff.ambiguityBlockedCount === 1 ? "" : "s"
                  } could not be matched to an existing card because more than one card claims the same identity — ${
                    diff.ambiguityBlockedCount === 1
                      ? "it will be saved as a new row"
                      : "they will be saved as new rows"
                  } rather than guessed at.`}
              </p>
            )}
          </div>

          <footer className="p-4 border-t border-gray-700 flex items-center justify-between gap-2 flex-wrap">
            {/* a11y (WCAG 4.1.3): this running total updates on every checkbox
                toggle, the same "cart count" shape the SC's own examples use —
                without a live region a screen-reader user gets no non-visual
                feedback that their tick changed the count that is about to be
                applied. role="status" only (no explicit aria-live): the role
                already implies aria-live="polite" + aria-atomic="true", and it
                never toggles to "alert" here, so there is no reason to add the
                explicit attribute — see the codebase's own status/alert notice
                pattern for when that IS needed. */}
            <span className="text-xs text-gray-400" role="status">
              {acceptedFieldCount} change
              {acceptedFieldCount === 1 ? "" : "s"} will be applied
              {anyOrphanSelected
                ? ` · ${selectedDeleteIds.length} card${
                    selectedDeleteIds.length === 1 ? "" : "s"
                  } will be deleted`
                : ""}
            </span>
            <div className="flex gap-2">
              <NeonButton
                ref={skipBtnRef}
                secondary
                size="2"
                disabled={saving}
                onClick={onSkip}
                // Deliberately NOT "Cancel": this does not cancel the sync. The
                // paired cards are still saved; only the content changes and
                // deletions on this screen are skipped.
                aria-label="Skip reviewing changes and continue"
              >
                Skip changes
              </NeonButton>
              <NeonButton
                ref={applyBtnRef}
                size="2"
                disabled={saving}
                onClick={handleApply}
                aria-label="Apply selected changes"
              >
                {saving ? "Saving…" : "Apply & Continue"}
              </NeonButton>
            </div>
          </footer>
        </div>

        {/* One confirm, for deletions only. Not a type-to-confirm: that is
            proportionate to deleting a whole set, not to a handful of cards an
            operator has just individually ticked. */}
        {confirmingDeletes && (
          <div
            ref={confirmDialogRef}
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="sync-delete-confirm-heading"
            aria-describedby="sync-delete-confirm-body"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                // Escape here backs out of the confirm ONLY. It must not also
                // skip the review behind it — one keypress that dismisses two
                // dialogs is how an operator loses work they had just
                // finished.
                e.stopPropagation();
                setConfirmingDeletes(false);
                // a11y: Apply & Continue is still mounted (only the confirm's
                // own DOM unmounts), so it is safe to focus synchronously —
                // no rAF/remount race to wait out. See applyBtnRef's comment.
                applyBtnRef.current?.focus();
                return;
              }
              if (e.key !== "Tab") return;
              // a11y: this alertdialog is a DOM descendant of the outer
              // review dialog's own `dialogRef`, so without stopping
              // propagation AND trapping Tab locally here, an unhandled Tab
              // bubbles up to the outer dialog's onKeyDown, which computes
              // its focusable set from the WHOLE subtree — including the
              // review dialog's own checkboxes and buttons sitting behind
              // this overlay. Concretely: Shift+Tab from this dialog's own
              // first focusable (Cancel) would not match the outer handler's
              // "first" element (the review dialog's own first checkbox), so
              // the outer handler no-ops and native Tab order takes over,
              // walking focus straight into content that is supposed to be
              // inert while this confirm is open. Trapping — and stopping
              // propagation — here keeps Tab entirely inside whichever
              // dialog is actually on top, matching what `aria-modal="true"`
              // promises.
              e.stopPropagation();
              const root = confirmDialogRef.current;
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
            <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-md p-4">
              <h3
                id="sync-delete-confirm-heading"
                className="text-base font-semibold text-gray-100"
              >
                Delete {selectedDeleteIds.length} card
                {selectedDeleteIds.length === 1 ? "" : "s"}?
              </h3>
              <p
                id="sync-delete-confirm-body"
                className="text-xs text-gray-400 mt-2"
              >
                These rows and their cross-listings are removed from NeonBinder.
                Anything that varies them is re-parented rather than deleted.
                This cannot be undone.
              </p>
              <div className="flex justify-end gap-2 mt-4">
                <NeonButton
                  ref={confirmCancelRef}
                  secondary
                  size="2"
                  onClick={() => {
                    setConfirmingDeletes(false);
                    // a11y: see applyBtnRef's comment above — this button is
                    // about to unmount while focused, and the review dialog
                    // stays open, so without this the browser drops focus to
                    // <body> the instant it disappears.
                    applyBtnRef.current?.focus();
                  }}
                  aria-label="Cancel deleting cards"
                >
                  Cancel
                </NeonButton>
                <NeonButton
                  cancel
                  size="2"
                  onClick={submit}
                  aria-label={`Confirm deleting ${selectedDeleteIds.length} cards`}
                >
                  Delete
                </NeonButton>
              </div>
            </div>
          </div>
        )}
      </div>
    </Theme>,
    document.body,
  );
}
