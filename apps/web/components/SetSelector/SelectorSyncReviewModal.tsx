import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { Theme } from "@radix-ui/themes";
import NeonButton from "../modules/NeonButton";
import type { Id } from "../../convex/_generated/dataModel";
import {
  ALL_SIDES,
  SIDE_LABEL,
  levelNoun,
  type SelectorLevel,
  type SyncSide,
} from "./selector-sync-feedback";

/**
 * NEO-211 phase C — "the marketplace calls this something else now".
 *
 * ## Why this is a review screen and not a sync step
 *
 * NeonBinder owns its set names. A re-sync refreshes marketplace LINKAGE and
 * never patches `value` — that is the whole point of NEO-211, and it is what
 * lets an operator rename "Topps" to "TCG" and keep it through every future
 * sync. But the marketplace's own label is still information: when BSC starts
 * calling a set something new, that is either a correction we want or a
 * marketplace quirk we do not, and only a human can tell which.
 *
 * So there is no pipeline here. `getSelectorSyncSuggestions` is DERIVED state —
 * it just compares the label the store already recorded against our own name —
 * and this dialog is the only thing that ever turns one into a write. Nothing is
 * staged, nothing expires, and closing this dialog changes nothing.
 *
 * ## Per SIDE, not per row
 *
 * A row can disagree with BOTH marketplaces at once, and their two labels need
 * not agree with each other either. Accepting BSC's label while declining
 * SportLots' is a normal outcome (BSC caught up to our spelling, SportLots did
 * not), so this is NOT the sync-review modal's three-way conflict radiogroup:
 * every side gets its own Accept / Decline pair, and a third resting state —
 * pressing the pressed button again returns that side to undecided.
 *
 * ## Nothing is pre-selected, with one exception
 *
 * Same rule as `sync-review-modal` (NEO-203): an operator who opens this and
 * closes it applies nothing. Not even a decline, which is still a write
 * (`declinedUpstreamLabels`) — a dialog must not write on being looked at.
 *
 * The exception is NEO-203's own tier-3 rule, `seedCheckedFields`: a `foldEqual`
 * suggestion is the same word under case/whitespace/accent folding, so it is a
 * reformatting rather than a rename, and starts pre-Accepted. Every case where
 * the words actually differ ("TCG" vs "Topps") starts unselected.
 *
 * ## No blanket "Accept all"
 *
 * A decline is inert; a rename is not — it changes `value`, which every form,
 * listing draft and search filter displays, and which can collide with a
 * sibling. A batch of unreviewed substantive renames is exactly the safety
 * property failing for the action hardest to notice went wrong. So the bulk
 * actions are "Decline all", scoped to the UNDECIDED sides so it cannot undo a
 * deliberate Accept, and "Accept all formatting-only suggestions", scoped to
 * `foldEqual` — the one bucket that is safe to bulk-accept.
 *
 * ## Escape closes
 *
 * NEO-203's Escape had to be a forward SKIP because that modal sits midway
 * through a commit pipeline that must still advance. This one is opened from an
 * idle column with no pipeline behind it, so the same rule collapses to the
 * trivial case: nothing was decided, nothing is lost, Escape is Close. There is
 * deliberately no confirm-on-Escape-with-pending-decisions guard — an
 * unsubmitted Accept is exactly as safe to discard as never having opened this.
 */

export type SelectorSuggestionSideEntry = {
  side: SyncSide;
  label: string;
  /**
   * Server-computed with the same `nameKey` fold `CardPairingModal` uses: does
   * the marketplace's label differ from our value only by case, whitespace or
   * accents? Drives the one pre-selected default.
   */
  foldEqual: boolean;
};

export type SelectorSyncSuggestion = {
  existingId: Id<"selectorOptions">;
  /** Our name for the row, as it stands right now. */
  currentValue: string;
  suggestions: SelectorSuggestionSideEntry[];
  /** The row's `lastUpdated` at read time — the server's stale check. */
  baseVersion: number;
};

export type SelectorSyncDecision = {
  existingId: Id<"selectorOptions">;
  baseVersion: number;
  side: SyncSide;
  action: "accept" | "decline";
};

export type SelectorSyncReviewResult = {
  decisions: SelectorSyncDecision[];
};

/** Per-side decision state. `undefined` (absent) is the resting, no-write state. */
export type SideChoice = "accept" | "decline";
export type ChoiceMap = Record<string, SideChoice>;

/**
 * The choice map's key. Mirrors `sync-review-modal`'s own `fieldKey`; `#`
 * cannot appear in a Convex id or in a side literal, so the join is
 * unambiguous.
 */
export const choiceKey = (existingId: string, side: SyncSide) =>
  `${existingId}#${side}`;

/**
 * The server caps a single apply call. Exported so the caller can slice and say
 * so, rather than have the mutation reject the whole batch.
 */
export const MAX_DECISIONS_PER_CALL = 200;

/**
 * The initial choice map: every side undecided EXCEPT the fold-equal ones.
 *
 * Exported and tested in its own right for the same reason NEO-203 exports
 * `seedCheckedFields` — this seeding IS the safety property, and a future
 * refactor that helpfully pre-picks something substantive has to fail a test
 * rather than ship.
 */
export function seedChoices(
  suggestions: readonly SelectorSyncSuggestion[],
): ChoiceMap {
  const seeded: ChoiceMap = {};
  for (const row of suggestions) {
    for (const s of row.suggestions) {
      if (s.foldEqual) {
        seeded[choiceKey(row.existingId as string, s.side)] = "accept";
      }
    }
  }
  return seeded;
}

/** Every `(row, side)` pair, in a stable BSC-then-SportLots order. */
export function allSideKeys(
  suggestions: readonly SelectorSyncSuggestion[],
): string[] {
  return suggestions.flatMap((row) =>
    ALL_SIDES.filter((side) => row.suggestions.some((s) => s.side === side)).map(
      (side) => choiceKey(row.existingId as string, side),
    ),
  );
}

/**
 * "Decline all" — every side with NO decision yet becomes a decline.
 *
 * Scoped to the undecided, never overwriting an explicit Accept: mirrors
 * `toggleAllFormatting`, which only ever touches its own group's keys. Bulk-
 * declining is safe at any size (a decline only stops the nagging), but silently
 * reversing a rename the operator just chose would not be.
 */
export function declineUndecided(
  suggestions: readonly SelectorSyncSuggestion[],
  choices: ChoiceMap,
): ChoiceMap {
  const next = { ...choices };
  for (const key of allSideKeys(suggestions)) {
    if (!next[key]) next[key] = "decline";
  }
  return next;
}

/** The undo for "Decline all": drop every decline, keep every accept. */
export function clearDeclines(choices: ChoiceMap): ChoiceMap {
  const next: ChoiceMap = {};
  for (const [key, value] of Object.entries(choices)) {
    if (value !== "decline") next[key] = value;
  }
  return next;
}

/** "Accept all formatting-only suggestions" — the `foldEqual` bucket only. */
export function acceptFormattingOnly(
  suggestions: readonly SelectorSyncSuggestion[],
  choices: ChoiceMap,
): ChoiceMap {
  const next = { ...choices };
  for (const row of suggestions) {
    for (const s of row.suggestions) {
      if (s.foldEqual) next[choiceKey(row.existingId as string, s.side)] = "accept";
    }
  }
  return next;
}

export function countFoldEqualSides(
  suggestions: readonly SelectorSyncSuggestion[],
): number {
  return suggestions.reduce(
    (n, row) => n + row.suggestions.filter((s) => s.foldEqual).length,
    0,
  );
}

/**
 * Turn the operator's per-side choices into the wire payload.
 *
 * `baseVersion` is read off the LIVE suggestion row here, not off anything
 * captured when the row was first seeded: `suggestions` comes from a reactive
 * query, so a concurrent admin's write re-renders this component with a fresh
 * version rather than leaving a stale one in front of the operator. What is left
 * is the genuine last-instant race between clicking Apply and the mutation
 * running, which is exactly what the server's own `baseVersion` check is for.
 *
 * Sides with no choice contribute NOTHING — not a decline, not a skip marker.
 * Undecided has to stay undecided across sessions, or "I'll look at this
 * tomorrow" silently becomes "I said no".
 */
export function buildDecisions(
  suggestions: readonly SelectorSyncSuggestion[],
  choices: ChoiceMap,
): SelectorSyncDecision[] {
  const decisions: SelectorSyncDecision[] = [];
  for (const row of suggestions) {
    for (const side of ALL_SIDES) {
      if (!row.suggestions.some((s) => s.side === side)) continue;
      const action = choices[choiceKey(row.existingId as string, side)];
      if (!action) continue;
      decisions.push({
        existingId: row.existingId,
        baseVersion: row.baseVersion,
        side,
        action,
      });
    }
  }
  return decisions;
}

/** The footer's running total, in decisions — what Apply is about to send. */
export function summariseChoices(
  suggestions: readonly SelectorSyncSuggestion[],
  choices: ChoiceMap,
): { accepting: number; declining: number; undecided: number } {
  const decisions = buildDecisions(suggestions, choices);
  const accepting = decisions.filter((d) => d.action === "accept").length;
  const declining = decisions.length - accepting;
  return {
    accepting,
    declining,
    undecided: allSideKeys(suggestions).length - decisions.length,
  };
}

function SuggestionSideRow({
  row,
  entry,
  choice,
  disabled,
  onChoose,
}: {
  row: SelectorSyncSuggestion;
  entry: SelectorSuggestionSideEntry;
  choice: SideChoice | undefined;
  disabled?: boolean;
  onChoose: (next: SideChoice | undefined) => void;
}) {
  const sideName = SIDE_LABEL[entry.side];
  // A two-option segmented control, not checkboxes: Accept and Decline are
  // mutually exclusive for a side, and pressing the pressed one returns to the
  // resting no-decision state.
  const toggle = (value: SideChoice) =>
    onChoose(choice === value ? undefined : value);

  const pill = (active: boolean) =>
    // py-1 (not py-0.5): text-xs's 1rem line-height plus 0.5rem/side vertical
    // padding plus the 1px border clears WCAG 2.5.8's 24px minimum target size;
    // py-0.5 landed at ~22px. border-gray-500 (not -600): -600 measures 2.35:1
    // against this dialog's bg-gray-900 — fails 1.4.11's 3:1 non-text minimum;
    // -500 measures 3.67:1.
    `text-xs px-2 py-1 rounded border transition-colors focus:outline-none focus:ring-2 focus:ring-[#00B7FF] disabled:opacity-50 ${
      active
        ? "border-[#00D558] bg-[#00D558]/20 text-[#00D558] font-semibold"
        : "border-gray-500 text-gray-300 hover:border-gray-400"
    }`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-sm text-gray-200 min-w-0 break-words">
        {/* Literal "BSC: {label}" / "SportLots: {label}" — the plan's own E2E
            acceptance asserts this exact string. Do not decorate it. */}
        {sideName}: {entry.label}
        {entry.foldEqual && (
          // Says WHY this one arrived pre-accepted. Words, not a colour.
          <span className="ml-1.5 text-[10px] uppercase tracking-wide text-gray-400">
            formatting only
          </span>
        )}
      </span>
      <span className="flex gap-1 shrink-0">
        <button
          type="button"
          disabled={disabled}
          aria-pressed={choice === "accept"}
          // WCAG 2.5.3 Label in Name: the visible word ("Accept") has to be a
          // substring of the accessible name, or a speech-input user saying
          // "click Accept" has nothing to match. Leads with it, then appends
          // the per-row context an aria-label already needs to disambiguate
          // rows sharing the same two words.
          aria-label={`Accept — rename "${row.currentValue}" to "${entry.label}" (from ${sideName})`}
          onClick={() => toggle("accept")}
          className={pill(choice === "accept")}
        >
          Accept
        </button>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={choice === "decline"}
          aria-label={`Decline — keep "${row.currentValue}"; stop suggesting ${sideName}'s "${entry.label}"`}
          onClick={() => toggle("decline")}
          className={pill(choice === "decline")}
        >
          Decline
        </button>
      </span>
    </div>
  );
}

export default function SelectorSyncReviewModal({
  isOpen,
  level,
  columnLabel,
  breadcrumb,
  suggestions,
  saving,
  restoreFocusRef,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  level?: SelectorLevel;
  /** Present for API symmetry with the query that produced `suggestions`. */
  parentId?: Id<"selectorOptions">;
  /** e.g. "Sets" — names the column in the heading. */
  columnLabel?: string;
  /** Ancestor chain, e.g. "Hockey › 1972-73 › Topps". Absent at sport level. */
  breadcrumb?: string;
  suggestions: SelectorSyncSuggestion[];
  saving?: boolean;
  /** a11y: where focus goes on close — see `sync-review-modal`'s own note. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
  /** Escape, or the footer's "Close". Writes nothing. */
  onClose: () => void;
  onConfirm: (result: SelectorSyncReviewResult) => void;
}) {
  // Seeded once. Re-seeding on every `suggestions` change would fight the
  // operator: the query is reactive, so a concurrent admin's unrelated write
  // would otherwise reset the choices they are part-way through making.
  const [choices, setChoices] = useState<ChoiceMap>(() =>
    seedChoices(suggestions),
  );

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const restoreTarget = restoreFocusRef?.current;
    triggerRef.current =
      restoreTarget ?? (document.activeElement as HTMLElement | null);
    // Focus lands on Close, not on Apply: the non-writing control is the safe
    // landing spot, same as the review dialog this is modelled on.
    const id = requestAnimationFrame(() => closeBtnRef.current?.focus());
    return () => {
      cancelAnimationFrame(id);
      triggerRef.current?.focus?.();
    };
  }, [isOpen, restoreFocusRef]);

  // `saving` disables every button in the dialog at once (Apply, Close, both
  // bulk actions, every per-side pill) — including whichever one the operator
  // just clicked, which the browser force-blurs to <body> the instant it goes
  // native-disabled. Park focus on the dialog itself so it isn't stranded for
  // the duration of the Apply round-trip. Matches the codebase's established
  // busy-flag focus-park pattern (confirm-dialog.tsx).
  useEffect(() => {
    if (saving) dialogRef.current?.focus();
  }, [saving]);

  const summary = useMemo(
    () => summariseChoices(suggestions, choices),
    [suggestions, choices],
  );
  const foldEqualCount = useMemo(
    () => countFoldEqualSides(suggestions),
    [suggestions],
  );

  const choose = useCallback(
    (key: string, next: SideChoice | undefined) => {
      setChoices((prev) => {
        if (!next) {
          const { [key]: _dropped, ...rest } = prev;
          return rest;
        }
        return { ...prev, [key]: next };
      });
    },
    [],
  );

  const handleApply = useCallback(() => {
    onConfirm({ decisions: buildDecisions(suggestions, choices) });
  }, [onConfirm, suggestions, choices]);

  if (!isOpen) return null;

  const decided = summary.accepting + summary.declining;
  // "Decline all" flips to its undo once there is nothing left undecided and at
  // least one decline exists to clear — same toggle-label shape as the orphan
  // section's Select all / Clear all in sync-review-modal.
  const declineIsClear = summary.undecided === 0 && summary.declining > 0;
  const noun = levelNoun(level, suggestions.length);

  return createPortal(
    <Theme>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="selector-sync-suggestions-heading"
        // A valid landing spot for the busy-park effect above: -1 keeps it out
        // of the normal Tab order while still being programmatically
        // focusable, and aria-labelledby already gives it an accessible name.
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onClose();
            return;
          }
          if (e.key !== "Tab") return;
          // aria-modal="true" promises Tab stays inside; deliver on it.
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
        <div className="bg-gray-900 border border-gray-700 rounded-lg w-full max-w-2xl max-h-[92vh] flex flex-col">
          <header className="p-4 border-b border-gray-700">
            <h2
              id="selector-sync-suggestions-heading"
              className="text-lg font-semibold text-gray-100"
            >
              Name Suggestions{columnLabel ? ` — ${columnLabel}` : ""}
            </h2>
            {breadcrumb && (
              // text-gray-400, not -500: this dialog is unconditionally
              // bg-gray-900 (no dark: split), and gray-500 measures 3.67:1
              // against it — fails WCAG 1.4.3's 4.5:1. gray-400 clears it
              // (6.82:1).
              <p className="text-xs text-gray-400 mt-0.5 truncate" title={breadcrumb}>
                {breadcrumb}
              </p>
            )}
            <p className="text-xs text-gray-400 mt-1">
              A marketplace is using a different name for {suggestions.length}{" "}
              {noun} you already have. NeonBinder owns these names — nothing
              changes unless you accept a suggestion here.
            </p>
          </header>

          <div className="p-4 overflow-y-auto space-y-3">
            {suggestions.length === 0 ? (
              // The affordance never opens this at zero, so this is the
              // live-shrank-to-empty case (a bulk decline, or another admin got
              // there first). Deliberately does not auto-close: that would fire
              // mid-keystroke on a slow bulk decline.
              <p className="text-sm text-gray-400">
                All caught up — nothing left to review.
              </p>
            ) : (
              suggestions.map((row) => (
                <div
                  key={row.existingId as string}
                  className="border border-gray-700 rounded-md p-3 space-y-1.5"
                >
                  <p className="text-sm font-semibold text-gray-100 break-words">
                    {row.currentValue}
                  </p>
                  {ALL_SIDES.flatMap((side) =>
                    row.suggestions.filter((s) => s.side === side),
                  ).map((entry) => (
                    <SuggestionSideRow
                      key={entry.side}
                      row={row}
                      entry={entry}
                      choice={
                        choices[choiceKey(row.existingId as string, entry.side)]
                      }
                      disabled={saving}
                      onChoose={(next) =>
                        choose(
                          choiceKey(row.existingId as string, entry.side),
                          next,
                        )
                      }
                    />
                  ))}
                </div>
              ))
            )}
          </div>

          <footer className="p-4 border-t border-gray-700 flex items-center justify-between gap-2 flex-wrap">
            {/* WCAG 4.1.3: the running total changes on every press and is the
                only feedback that a choice registered. role="status" already
                implies polite + atomic, so no explicit aria-live. */}
            <span className="text-xs text-gray-400" role="status">
              {summary.accepting} to accept · {summary.declining} to decline
            </span>
            <div className="flex gap-2 flex-wrap">
              {foldEqualCount > 0 && (
                <NeonButton
                  secondary
                  size="2"
                  disabled={saving}
                  onClick={() =>
                    setChoices((prev) => acceptFormattingOnly(suggestions, prev))
                  }
                  aria-label={`Accept all ${foldEqualCount} formatting-only suggestions`}
                >
                  Accept all formatting-only suggestions ({foldEqualCount})
                </NeonButton>
              )}
              <NeonButton
                secondary
                size="2"
                disabled={saving || suggestions.length === 0}
                onClick={() =>
                  setChoices((prev) =>
                    declineIsClear
                      ? clearDeclines(prev)
                      : declineUndecided(suggestions, prev),
                  )
                }
                aria-label={
                  declineIsClear
                    ? "Clear every decline and leave those suggestions undecided"
                    : `Decline the ${summary.undecided} undecided suggestions and keep our names`
                }
              >
                {declineIsClear
                  ? "Clear declines"
                  : `Decline all (${summary.undecided})`}
              </NeonButton>
              <NeonButton
                ref={closeBtnRef}
                cancel
                size="2"
                disabled={saving}
                onClick={onClose}
                aria-label="Close without applying any decisions"
              >
                Close
              </NeonButton>
              <NeonButton
                size="2"
                disabled={saving || decided === 0}
                onClick={handleApply}
                aria-label="Apply decisions"
              >
                {saving ? "Saving…" : "Apply"}
              </NeonButton>
            </div>
          </footer>
        </div>
      </div>
    </Theme>,
    document.body,
  );
}
