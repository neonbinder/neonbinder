import { useId, useState, type KeyboardEvent, type Ref } from "react";
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
 * Each column IS its choice: the radio sits under the answer it keeps, and
 * the column the operator picked is lit (border, a tint and a ✓ beside the
 * radio, so "picked" is never colour alone; the column turned down keeps
 * full strength, so both answers stay readable). Nothing is pre-picked — a
 * default here would be the silent settlement the rule forbids — and the
 * wizard holds Next until every card has an answer. The answer is applied to
 * the card on the client and is never stored.
 *
 * ## Semantics
 *
 * The list stays a plain list. Inside each `<li>`, the card is ONE required
 * radio group, "Disagreement on #60" (`aria-required`), whose two radios are
 * named exactly by their visible labels. Under the list, an always-mounted
 * status line says how far along the operator is ("Picked 1 of 2 cards.",
 * then "… All answered — hit Next!"), unless Next was just pressed while a
 * card is still open, which it says instead.
 *
 * ## Keyboard
 *
 * The house radio-group pattern (AutographFormatStep, ModeRadioGroup): each
 * card is ONE Tab stop, on its picked radio, else on "Keep the
 * marketplace's". Arrow keys move between the two radios and pick, wrapping.
 * Space or a click picks. Enter picks AND moves focus to the next card still
 * waiting, so a long list can be answered without reaching for Tab; on the
 * last one it lands on Next. A held (repeating) Enter is refused.
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
 * The two radios, per card — fixed: the E2E suite targets them. A straight
 * apostrophe on purpose: an accessible-name match is exact characters, and
 * the contract the specs are written against spells it this way.
 */
export const KEEP_MARKETPLACE_LABEL = "Keep the marketplace's";
export const USE_CHECKLIST_LABEL = "Use the checklist's";
/** Said in the step's status line when Next is pressed with cards unanswered. */
export const CHECKLIST_NEXT_BLOCKED = "Pick a side on every card first — then Next.";

/**
 * The status line after a pick: "Picked 1 of 2 cards." while cards are open,
 * and "Picked 2 of 2 cards. All answered — hit Next!" once none is.
 */
export function checklistPickedText(picked: number, total: number): string {
  const counted = `Picked ${picked} of ${total} ${total === 1 ? "card" : "cards"}.`;
  return picked >= total ? `${counted} All answered — hit Next!` : counted;
}

/** One line under the heading. */
export function checklistStepLead(count: number): string {
  return count === 1
    ? "Your checklist and the marketplace don’t agree on this card. Which one’s right?"
    : `Your checklist and the marketplace don’t agree on ${count} cards. Which one’s right on each?`;
}

/** "Disagreement on #60" — each card's radio group name. */
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
    <div className="text-sm">
      <p className="mb-1 text-xs font-semibold text-ink-3">{title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
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
    </div>
  );
}

const SIDES = ["marketplace", "checklist"] as const satisfies readonly ChecklistChoice[];

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
  /** The first unanswered card's first radio — the host focuses it on arrival. */
  firstOpenRef?: Ref<HTMLButtonElement>;
  hintId: string;
  /**
   * Next was pressed while a card is still open. A number counts the
   * presses, so a second blocked press after some picks says it again; a
   * boolean says it from the first press until the next pick.
   */
  showBlockedHint?: boolean | number;
}) {
  const leadId = useId();
  /**
   * The last pick made on this step, and the blocked-press signal it was
   * made under: a press AFTER it (a new signal) wins the status line, a pick
   * after the press takes it back. Null until the operator picks here, so
   * arriving (or coming Back) says nothing.
   */
  const [lastPick, setLastPick] = useState<{ under: boolean | number } | null>(null);
  const unanswered = rows.filter((r) => choices[r.index] === undefined);
  const firstOpen = unanswered[0]?.index;

  const blockedSaid =
    !!showBlockedHint &&
    unanswered.length > 0 &&
    (lastPick === null || lastPick.under !== showBlockedHint);
  const statusText = blockedSaid
    ? CHECKLIST_NEXT_BLOCKED
    : lastPick
      ? checklistPickedText(rows.length - unanswered.length, rows.length)
      : "";

  const radioOf = (row: ChecklistConflictRow, side: ChecklistChoice) =>
    document.querySelector<HTMLButtonElement>(
      `[data-checklist-conflict="${row.index}"] [data-checklist-side="${side}"]`,
    );

  const pick = (row: ChecklistConflictRow, choice: ChecklistChoice, walk: boolean) => {
    if (disabled) return;
    onChoose(row.index, choice);
    setLastPick({ under: showBlockedHint });
    if (!walk) return;
    // Enter: on to the next card still waiting, or out to Next.
    const next = rows.find((r) => r.index !== row.index && choices[r.index] === undefined);
    if (!next) {
      onAllAnswered?.();
      return;
    }
    document
      .querySelector<HTMLButtonElement>(`[data-checklist-conflict="${next.index}"] button`)
      ?.focus();
  };

  const onKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    row: ChecklistConflictRow,
    side: ChecklistChoice,
  ) => {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step !== 0) {
      event.preventDefault();
      if (disabled) return;
      const at = SIDES.indexOf(side);
      const to = SIDES[(at + step + SIDES.length) % SIDES.length];
      pick(row, to, false);
      radioOf(row, to)?.focus();
      return;
    }
    if (event.key !== "Enter") return;
    // Never the button's default click (it would pick twice), never the
    // wizard's own Enter.
    event.preventDefault();
    event.stopPropagation();
    if (event.repeat) return;
    pick(row, side, true);
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
          const tabStop: ChecklistChoice = chosen ?? "marketplace";
          return (
            <li key={row.index} data-checklist-conflict={row.index}>
              <div
                role="radiogroup"
                aria-label={disagreementLabel(row.cardNumber)}
                aria-required="true"
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
                  {SIDES.map((side) => {
                    const picked = chosen === side;
                    const label = side === "marketplace" ? KEEP_MARKETPLACE_LABEL : USE_CHECKLIST_LABEL;
                    return (
                      <div
                        key={side}
                        className={`flex flex-col justify-between gap-2 p-3 ${
                          side === "checklist" ? "border-t border-rule sm:border-t-0 sm:border-l" : ""
                        } ${picked ? "bg-neon-green/10 shadow-[inset_0_0_0_2px_var(--color-neon-green-text)]" : ""}`}
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
                            role="radio"
                            aria-checked={picked}
                            aria-disabled={disabled || undefined}
                            tabIndex={side === tabStop ? 0 : -1}
                            data-checklist-side={side}
                            onClick={() => pick(row, side, false)}
                            onKeyDown={(event) => onKeyDown(event, row, side)}
                            className={`rounded-md border-2 px-3 py-1.5 text-sm font-semibold transition-colors focus-outline max-sm:min-h-11 ${
                              picked
                                ? "border-neon-green-text text-neon-green-text"
                                : "border-control text-ink-2 hover:border-ink-2"
                            } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
                          >
                            {label}
                          </button>
                          {/* 1.4.1 — picked is not colour alone. Beside the
                              radio, never inside it, so its name stays
                              exactly the label. */}
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
              </div>
            </li>
          );
        })}
      </ul>
      {/* Always mounted: a live region must exist before it speaks. */}
      <p id={hintId} role="status" className="text-xs text-ink-2">
        {statusText}
      </p>
    </div>
  );
}
