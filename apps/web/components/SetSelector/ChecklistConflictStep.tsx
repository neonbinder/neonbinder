import { useId, type KeyboardEvent, type Ref } from "react";
import {
  sideText,
  type ChecklistChoice,
  type ChecklistConflict,
} from "./checklist-conflict";

/**
 * NEO-478 — the wizard's "Checklist says otherwise" step.
 *
 * The operator added the publisher's checklist, and on some cards it names
 * different players or teams than the marketplace listing. Rule 7 says a
 * number/player disagreement is a likely misread, surfaced and never settled
 * silently, so each card is put to the operator with both answers side by
 * side:
 *
 *   ┌ #60 ─────────────────────────────────────────────────────────┐
 *   │  MARKETPLACE                    │  YOUR CHECKLIST            │
 *   │  Players  Rhett Lowder          │  Players  Rhett Loder      │
 *   │  Team     Reds                  │  Team     Cincinnati Reds  │
 *   │  [Keep the marketplace's]       │  [Use the checklist's]     │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Each column IS its choice: the button sits under the answer it keeps, and
 * the column the operator picked is lit (border and a ✓ beside the button,
 * so "picked" is never colour alone). Nothing is pre-picked — a default here
 * would be the silent settlement the rule forbids — and the wizard holds Next
 * until every card has an answer. The answer is applied to the card on the
 * client and is never stored.
 *
 * Keyboard: Tab walks the buttons in reading order (each card's marketplace
 * button, then its checklist button). Enter or Space picks. Enter on a pick
 * also moves focus to the next card still waiting, so a long list can be
 * answered without reaching for Tab; on the last one it lands on Next.
 */

export type ChecklistConflictRow = {
  /** Position in the wizard's preview cards. */
  index: number;
  cardNumber: string;
  cardName: string;
  conflict: ChecklistConflict;
};

/** The step's heading — fixed: the E2E suite targets it. */
export const CHECKLIST_STEP_HEADING = "Checklist says otherwise";
/**
 * The two buttons, per card — fixed: the E2E suite targets them. A straight
 * apostrophe on purpose: an accessible-name match is exact characters, and
 * the contract the specs are written against spells it this way.
 */
export const KEEP_MARKETPLACE_LABEL = "Keep the marketplace's";
export const USE_CHECKLIST_LABEL = "Use the checklist's";
/** Said in the step's status line when Next is pressed with cards unanswered. */
export const CHECKLIST_NEXT_BLOCKED = "Pick a side on every card first — then Next.";

/** One line under the heading. */
export function checklistStepLead(count: number): string {
  return count === 1
    ? "Your checklist and the marketplace don’t agree on this card. Which one’s right?"
    : `Your checklist and the marketplace don’t agree on ${count} cards. Which one’s right on each?`;
}

/** "Disagreement on #60" — each card's group name. */
export function disagreementLabel(cardNumber: string): string {
  return `Disagreement on #${cardNumber}`;
}

const NOBODY = "Nobody listed";
const NO_TEAM = "No team listed";

function Side({
  title,
  conflict,
  side,
  picked,
}: {
  title: string;
  conflict: ChecklistConflict;
  side: ChecklistChoice;
  picked: boolean;
}) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="col-span-2 mb-0.5 text-xs font-semibold text-ink-3">{title}</dt>
      {conflict.players && (
        <>
          <dt className="text-ink-3">Players</dt>
          <dd className={picked ? "text-ink" : "text-ink-2"}>
            {sideText(conflict.players[side], NOBODY)}
          </dd>
        </>
      )}
      {conflict.teams && (
        <>
          <dt className="text-ink-3">{conflict.teams[side].length > 1 ? "Teams" : "Team"}</dt>
          <dd className={picked ? "text-ink" : "text-ink-2"}>
            {sideText(conflict.teams[side], NO_TEAM)}
          </dd>
        </>
      )}
    </dl>
  );
}

export default function ChecklistConflictStep({
  rows,
  choices,
  onChoose,
  onAllAnswered,
  disabled = false,
  headingId,
  firstOpenRef,
  hintId,
  showBlockedHint = false,
}: {
  rows: readonly ChecklistConflictRow[];
  /** The operator's answers, by preview index. */
  choices: Readonly<Record<number, ChecklistChoice>>;
  onChoose: (index: number, choice: ChecklistChoice) => void;
  /** Enter picked the last open card: the host moves focus on (to Next). */
  onAllAnswered?: () => void;
  disabled?: boolean;
  headingId: string;
  /** The first unanswered card's first button — the host focuses it on arrival. */
  firstOpenRef?: Ref<HTMLButtonElement>;
  hintId: string;
  showBlockedHint?: boolean;
}) {
  const leadId = useId();
  const unanswered = rows.filter((r) => choices[r.index] === undefined);
  const firstOpen = unanswered[0]?.index;

  const pick = (
    event: KeyboardEvent<HTMLButtonElement> | null,
    row: ChecklistConflictRow,
    choice: ChecklistChoice,
  ) => {
    if (disabled) return;
    onChoose(row.index, choice);
    if (!event) return;
    // Enter: on to the next card still waiting, or out to Next.
    const next = rows.find((r) => r.index !== row.index && choices[r.index] === undefined);
    if (!next) {
      onAllAnswered?.();
      return;
    }
    const target = document.querySelector<HTMLButtonElement>(
      `[data-checklist-conflict="${next.index}"] button`,
    );
    target?.focus();
  };

  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    row: ChecklistConflictRow,
    choice: ChecklistChoice,
  ) => {
    if (event.key !== "Enter") return;
    // Never the button's default click (it would pick twice), never the
    // wizard's own Enter.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    pick(event, row, choice);
  };

  return (
    <div className="space-y-3">
      <div>
        <h3 id={headingId} className="text-sm font-semibold text-ink">
          {CHECKLIST_STEP_HEADING}
        </h3>
        <p id={leadId} className="mt-0.5 text-sm text-ink-2">
          {checklistStepLead(rows.length)}
        </p>
      </div>
      <ul className="space-y-3" aria-describedby={leadId}>
        {rows.map((row) => {
          const chosen = choices[row.index];
          return (
            <li
              key={row.index}
              role="group"
              aria-label={disagreementLabel(row.cardNumber)}
              data-checklist-conflict={row.index}
              className="rounded-lg border border-rule-strong bg-raised"
            >
              <p className="flex items-baseline gap-2 border-b border-rule px-3 py-1.5 text-sm">
                <span className="font-semibold tabular-nums text-neon-green-text">
                  #{row.cardNumber}
                </span>
                <span className="min-w-0 truncate text-ink-2">{row.cardName}</span>
                {chosen === undefined && (
                  <span className="ml-auto shrink-0 text-xs text-neon-pink-text">Needs a pick</span>
                )}
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2">
                {(["marketplace", "checklist"] as const).map((side) => {
                  const picked = chosen === side;
                  const label = side === "marketplace" ? KEEP_MARKETPLACE_LABEL : USE_CHECKLIST_LABEL;
                  return (
                    <div
                      key={side}
                      className={`flex flex-col justify-between gap-2 p-3 ${
                        side === "checklist" ? "border-t border-rule sm:border-t-0 sm:border-l" : ""
                      } ${picked ? "bg-neon-green/10 shadow-[inset_0_0_0_2px_var(--color-neon-green-text)]" : ""} ${
                        chosen !== undefined && !picked ? "opacity-70" : ""
                      }`}
                    >
                      <Side
                        title={side === "marketplace" ? "Marketplace" : "Your checklist"}
                        conflict={row.conflict}
                        side={side}
                        picked={picked}
                      />
                      <div className="flex items-center gap-2">
                        <button
                          ref={
                            row.index === firstOpen && side === "marketplace"
                              ? firstOpenRef
                              : undefined
                          }
                          type="button"
                          aria-pressed={picked}
                          aria-disabled={disabled || undefined}
                          onClick={() => pick(null, row, side)}
                          onKeyDown={(event) => onKeyDown(event, row, side)}
                          className={`rounded-md border-2 px-3 py-1.5 text-sm font-semibold transition-colors focus-outline max-sm:min-h-11 ${
                            picked
                              ? "border-neon-green-text text-neon-green-text"
                              : "border-control text-ink-2 hover:border-ink-2"
                          } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
                        >
                          {label}
                        </button>
                        {/* 1.4.1 — picked is not colour alone. */}
                        {picked && (
                          <span aria-hidden="true" className="text-neon-green-text">
                            ✓
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>
      <p id={hintId} role="status" className="text-xs text-ink-2">
        {showBlockedHint && unanswered.length > 0 ? CHECKLIST_NEXT_BLOCKED : null}
      </p>
    </div>
  );
}
