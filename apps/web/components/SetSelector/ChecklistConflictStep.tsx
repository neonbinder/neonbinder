import { useId, useState, type KeyboardEvent, type Ref } from "react";
import NeonButton from "../modules/NeonButton";
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
 *   Same answer for every card: [Keep the marketplace's on all] [Use the checklist's on all]
 *   ┌ #60 ─────────────────────────────────────────────────────────┐
 *   │  Marketplace                    │  Your checklist            │
 *   │  Player   Rhett Lowder          │  Player   Rhett Loder      │
 *   │  Team     Reds                  │  Team     Cincinnati Reds  │
 *   │  [Keep the marketplace's]       │  [Use the checklist's]     │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Each column IS its choice: the radio sits under the answer it keeps, and
 * the column the operator picked carries the selection mark (a 4px edge in
 * the selection colour down its left, a neutral tint, and a ✓ beside the
 * radio, so "picked" is never colour alone; the column turned down keeps
 * full strength, so both answers stay readable). Nothing is pre-picked — a
 * default here would be the silent settlement the rule forbids — and the
 * wizard holds Next until every card has an answer. The answer is applied to
 * the card on the client and is never stored.
 *
 * The heading is the card number alone, "#60": the card's stored name is one
 * side's spelling, and putting it on top took that side. Where the two
 * spellings differ, the characters that differ are underlined and tinted on
 * both sides (Burgess / Bugress), so a one-letter misread is seen at a glance.
 *
 * A checklist row that said "No Team" against a card the marketplace gave a
 * team (NEO-489) is a teams disagreement whose checklist side is empty; that
 * side reads "No team on the card" (`CHECKLIST_NO_TEAM`) at full ink, picked
 * or not, because it is the checklist's answer rather than a gap. An empty
 * marketplace side still reads "No team listed": the listing named none.
 *
 * With two or more cards, "Keep the marketplace's on all" and "Use the
 * checklist's on all" answer every card in one press (the operator has just
 * pressed the button, so this is no default); each card can then be changed
 * on its own. Either one updates the "Picked N of M" status.
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

/** The bulk answers, shown with two or more cards. */
export const KEEP_MARKETPLACE_ALL_LABEL = "Keep the marketplace's on all";
export const USE_CHECKLIST_ALL_LABEL = "Use the checklist's on all";
/** The bulk answers' group label. */
export const BULK_ANSWER_LABEL = "Same answer for every card:";

/** One run of a name: characters the other side shares, or ones it does not. */
export type NameSegment = { text: string; differs: boolean };

/** Longer than this, a name is shown plain: the comparison is quadratic. */
const DIFF_MAX = 400;
/**
 * Below this share of the longer name in common, two names are simply
 * different names ("Reds" / "Cincinnati Reds", "Mike Trout" / "Shohei
 * Ohtani"), not one misread: scattered marks there would be noise.
 */
const DIFF_MIN_SHARED = 0.6;

function runs(text: string, keep: boolean[]): NameSegment[] {
  const out: NameSegment[] = [];
  for (let i = 0; i < text.length; i++) {
    const differs = !keep[i];
    const last = out[out.length - 1];
    if (last && last.differs === differs) last.text += text[i];
    else out.push({ text: text[i], differs });
  }
  return out;
}

/**
 * The characters each of two names does not share with the other, as runs:
 * "Trevor Burgess" / "Trevor Bugress" marks the "r" each has where the other
 * does not. Read off a longest common subsequence, character by character
 * and case-sensitive. Two equal names, an empty side, a name over
 * `DIFF_MAX` characters, or two names sharing under `DIFF_MIN_SHARED` of the
 * longer one come back as one plain run each.
 */
export function differingRuns(a: string, b: string): { a: NameSegment[]; b: NameSegment[] } {
  const plain = (t: string): NameSegment[] => (t === "" ? [] : [{ text: t, differs: false }]);
  if (a === b || a === "" || b === "" || a.length > DIFF_MAX || b.length > DIFF_MAX) {
    return { a: plain(a), b: plain(b) };
  }
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the common subsequence of a[i..] and b[j..], flattened.
  const lcs = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[at(i, j)] =
        a[i] === b[j] ? lcs[at(i + 1, j + 1)] + 1 : Math.max(lcs[at(i + 1, j)], lcs[at(i, j + 1)]);
    }
  }
  if (lcs[at(0, 0)] < DIFF_MIN_SHARED * Math.max(n, m)) return { a: plain(a), b: plain(b) };
  const keepA = new Array<boolean>(n).fill(false);
  const keepB = new Array<boolean>(m).fill(false);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keepA[i++] = true;
      keepB[j++] = true;
    } else if (lcs[at(i + 1, j)] >= lcs[at(i, j + 1)]) {
      i++;
    } else {
      j++;
    }
  }
  return { a: runs(a, keepA), b: runs(b, keepB) };
}

/**
 * A name with its differing runs marked. Not colour alone: an underline, and
 * a tint behind. Plain spans, so the name still reads as one word.
 */
function MarkedName({ segments }: { segments: readonly NameSegment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        seg.differs ? (
          <span
            key={i}
            data-name-differs=""
            className="rounded-sm bg-chip font-semibold text-ink underline decoration-neon-pink-text decoration-2 underline-offset-[3px]"
          >
            {seg.text}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </>
  );
}

const NOBODY = "Nobody listed";
const NO_TEAM = "No team listed";
/**
 * NEO-489 — the checklist's side of a teams disagreement is empty only when
 * its row said "No Team": a claim that the card shows no team, not a gap, so
 * it reads as the answer it is. ("Use the checklist's" then saves the card
 * with no team; `applyChecklistChoice`.)
 */
export const CHECKLIST_NO_TEAM = "No team on the card";

const OTHER: Record<ChecklistChoice, ChecklistChoice> = {
  marketplace: "checklist",
  checklist: "marketplace",
};

/** One side's names, with the runs the other side does not share marked. */
function SideNames({
  sides,
  side,
  empty,
}: {
  sides: { marketplace: string[]; checklist: string[] };
  side: ChecklistChoice;
  empty: string;
}) {
  const mine = sides[side];
  const theirs = sides[OTHER[side]];
  if (mine.length === 0) return <>{empty}</>;
  if (theirs.length === 0) return <>{sideText(mine, empty)}</>;
  // Always marketplace first, so both sides read off the SAME alignment
  // (the two orders can break a tie differently: Burgess / Bugress).
  const runsOf = differingRuns(
    sideText(sides.marketplace, empty),
    sideText(sides.checklist, empty),
  );
  return <MarkedName segments={side === "marketplace" ? runsOf.a : runsOf.b} />;
}

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
            <dt className="text-ink-3">
              {conflict.players[side].length > 1 ? "Players" : "Player"}
            </dt>
            <dd className={picked ? "text-ink" : "text-ink-2"}>
              <SideNames sides={conflict.players} side={side} empty={NOBODY} />
            </dd>
          </>
        )}
        {conflict.teams && (
          <>
            <dt className="text-ink-3">{conflict.teams[side].length > 1 ? "Teams" : "Team"}</dt>
            <dd
              className={
                // The checklist's No Team is an answer, not a gap: full ink.
                picked || (side === "checklist" && conflict.teams.checklist.length === 0)
                  ? "text-ink"
                  : "text-ink-2"
              }
            >
              <SideNames
                sides={conflict.teams}
                side={side}
                empty={side === "checklist" ? CHECKLIST_NO_TEAM : NO_TEAM}
              />
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
  const bulkLabelId = useId();
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

  /** One press answers every card the same way; each can be changed after. */
  const pickAll = (choice: ChecklistChoice) => {
    if (disabled) return;
    for (const row of rows) {
      if (choices[row.index] !== choice) onChoose(row.index, choice);
    }
    setLastPick({ under: showBlockedHint });
  };

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
      {rows.length > 1 && (
        // Buttons, not a third radio: each sets every card's own radio, and
        // the cards stay the answer. Outside the list, so a card's first
        // button is still its "Keep the marketplace's" radio.
        <div
          role="group"
          aria-labelledby={bulkLabelId}
          className="flex flex-wrap items-center gap-x-3 gap-y-2"
        >
          <span id={bulkLabelId} className="text-xs text-ink-2">
            {BULK_ANSWER_LABEL}
          </span>
          <NeonButton
            size="1"
            variant="secondary"
            outline
            onClick={() => pickAll("marketplace")}
            aria-disabled={disabled || undefined}
            aria-describedby={hintId}
            className="max-sm:min-h-11"
          >
            {KEEP_MARKETPLACE_ALL_LABEL}
          </NeonButton>
          <NeonButton
            size="1"
            variant="secondary"
            outline
            onClick={() => pickAll("checklist")}
            aria-disabled={disabled || undefined}
            aria-describedby={hintId}
            className="max-sm:min-h-11"
          >
            {USE_CHECKLIST_ALL_LABEL}
          </NeonButton>
        </div>
      )}
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
                {/* The number alone: the card's name is one side's
                    spelling, and the heading must not take a side. */}
                <p className="flex items-baseline gap-2 border-b border-rule px-3 py-1.5 text-sm">
                  <span className="font-semibold tabular-nums text-neon-green-text">
                    #{row.cardNumber}
                  </span>
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
                        } ${
                          // The selection role's mark, not the keyboard
                          // highlight's full ring: a 4px edge down the left
                          // and a neutral tint (the ✓ says it in words).
                          picked
                            ? "bg-list-hover-raised shadow-[inset_4px_0_0_var(--color-selection)]"
                            : ""
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
