import { useEffect, useId, useMemo, useRef, type KeyboardEvent } from "react";
import { useQueries } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { activateOnEnter } from "../../lib/dom/activate-on-enter";
import { contrastRatio, normalizeHexColor } from "../../lib/print/contrast";
import { useFieldTestClass } from "../../src/hooks/useFieldTestClass";
import {
  buildTeamsGroups,
  effectiveChoice,
  evidenceRequests,
  optionLabel,
  sameTeamAnswers,
  teamAnswersByCard,
  TEAMS_SECTION_MAX_REQUESTS,
  TEAMS_SECTION_PLAYERS_PER_REQUEST,
  type GroupChoice,
  type PreviewCardForTeams,
  type ServerPlayerEvidence,
  type TeamAnswer,
  type TeamOption,
  type TeamRef,
  type TeamsGroup,
  type TeamsReviewRow,
} from "./teams-on-cards";

/**
 * NEO-335 — "K cards have no team yet", on the entity review wizard's final
 * step, below "All reviewed — save N cards?".
 *
 * The cards the operator is about to save that will land with no team, one
 * line per player set: a pre-filled team when the evidence gives exactly one
 * answer, unselected teams when it gives several, "No team on this card", and
 * "Leave for later" (the default when there is no evidence). Deciding lives in
 * `teams-on-cards.ts`; this component reads the server's evidence, draws the
 * lines and reports the answers up.
 *
 * It never gates Confirm & Save: a line left for later saves teamless, which
 * is exactly what happened before this section existed, and the attention
 * walker picks it up after the save.
 *
 * Renders nothing when no card is teamless — and still reports an all-empty
 * answer list, so an answer given before the operator went back and changed a
 * Names-phase decision cannot outlive the card it was given for.
 *
 * ## Keyboard and screen readers
 *
 * Each line is an APG radio group (`ChoiceList` in SetShapeDialog is the house
 * precedent): one Tab stop per line on the checked radio, arrow keys move the
 * selection with focus and wrap, Enter chooses (`activateOnEnter`, which also
 * keeps the key off Confirm & Save's handler). Every radio's accessible name
 * starts with its visible words and ends with whose line it is, so the names
 * stay unique across lines (Maestro matches `id:` as an unanchored regex).
 * Focus is never taken: Confirm & Save keeps the autofocus it has always had.
 */

/** The chip ground, for the livery contrast check. Tailwind gray-800. */
const CHIP_GROUND = "#1f2937";
/** WCAG 2.2 SC 1.4.3 for text this size. */
const LIVERY_MIN_CONTRAST = 4.5;

/**
 * The team's own colour for its name, or null to leave it in the chip's
 * default. Primary first, secondary as the fallback — the order the set
 * builder's summary bar uses, for the same reason: a franchise built on a
 * near-black navy usually prints on its pale secondary. Colour is never the
 * only carrier; the name reads the same either way (SC 1.4.1).
 */
function liveryTextColor(colors: TeamRef["colors"]): string | null {
  for (const candidate of [colors?.primary, colors?.secondary]) {
    if (!candidate) continue;
    const hex = normalizeHexColor(candidate);
    if (!hex) continue;
    const ratio = contrastRatio(hex, CHIP_GROUND);
    if (ratio !== null && ratio >= LIVERY_MIN_CONTRAST) return hex;
  }
  return null;
}

/** A valid primary for the swatch, else null. The swatch is decoration. */
function swatchColor(colors: TeamRef["colors"]): string | null {
  return colors?.primary ? normalizeHexColor(colors.primary) : null;
}

const NONE_LABEL = "No team on this card";
const LATER_LABEL = "Leave for later";

type Choice = { id: string; choice: GroupChoice; option?: TeamOption; label: string };

function lineChoices(group: TeamsGroup): Choice[] {
  return [
    ...group.options.map((option) => ({
      id: `team:${option.key}`,
      choice: { kind: "team", optionKey: option.key } as GroupChoice,
      option,
      label: optionLabel(option),
    })),
    { id: "none", choice: { kind: "none" }, label: NONE_LABEL },
    { id: "later", choice: { kind: "later" }, label: LATER_LABEL },
  ];
}

function choiceId(choice: GroupChoice): string {
  return choice.kind === "team" ? `team:${choice.optionKey}` : choice.kind;
}

/** Whose line it is, in words — the second half of every radio's name. */
function lineOwner(group: TeamsGroup): string {
  if (group.players.length > 0) {
    const who = group.players.join(" & ");
    return group.cards.length > 1 ? `${who}, ${group.cards.length} cards` : who;
  }
  const card = group.cards[0];
  return `#${card.cardNumber} ${card.cardName}`;
}

export default function TeamsOnCardsSection({
  selectorOptionId,
  cards,
  rows,
  linkedTeamNameById,
  choices,
  onChoose,
  onAnswersChange,
  inheritsSetTeam = false,
  disabled = false,
}: {
  /** The node the cards will be saved under — the server reads the set from it. */
  selectorOptionId: Id<"selectorOptions">;
  /** The confirmed preview cards, in preview order. */
  cards: readonly PreviewCardForTeams[];
  /** The review batch, every row decided. */
  rows: readonly TeamsReviewRow[];
  /** Linked team id → full name, for a team the operator linked in the Names phase. */
  linkedTeamNameById: ReadonlyMap<string, string>;
  /** The operator's own picks, by group key. Absent = the line's default. */
  choices: Readonly<Record<string, GroupChoice>>;
  onChoose: (groupKey: string, choice: GroupChoice) => void;
  /** Every card's answer, positionally aligned with `cards`. */
  onAnswersChange: (answers: Array<TeamAnswer | undefined>) => void;
  /**
   * The node carries a set-level team (NEO-277), which the commit gives every
   * NEW card that arrives without one. Nothing here would save teamless, so
   * there is nothing to ask. (A re-synced EXISTING row keeps its own stored
   * team instead; the browser cannot tell the two apart before the commit
   * matches them, and an existing row is the rarer case.)
   */
  inheritsSetTeam?: boolean;
  /** A commit is in flight; the choices hold still. */
  disabled?: boolean;
}) {
  const headingId = useId();
  const fieldClass = useFieldTestClass();

  const requests = useMemo(
    () =>
      (inheritsSetTeam ? [] : evidenceRequests(cards, rows)).slice(
        0,
        TEAMS_SECTION_PLAYERS_PER_REQUEST * TEAMS_SECTION_MAX_REQUESTS,
      ),
    [cards, rows, inheritsSetTeam],
  );
  const queries = useMemo(() => {
    const out: Record<
      string,
      {
        query: typeof api.cardChecklist.teamSuggestionsForPreview;
        args: {
          selectorOptionId: Id<"selectorOptions">;
          players: Array<{ playerId?: Id<"players">; name?: string }>;
        };
      }
    > = {};
    for (let i = 0; i < requests.length; i += TEAMS_SECTION_PLAYERS_PER_REQUEST) {
      out[`slice${i / TEAMS_SECTION_PLAYERS_PER_REQUEST}`] = {
        query: api.cardChecklist.teamSuggestionsForPreview,
        args: {
          selectorOptionId,
          players: requests
            .slice(i, i + TEAMS_SECTION_PLAYERS_PER_REQUEST)
            .map((r) => (r.playerId ? { playerId: r.playerId } : { name: r.name ?? "" })),
        },
      };
    }
    return out;
  }, [requests, selectorOptionId]);
  const results = useQueries(queries);

  const { serverEvidence, setYear } = useMemo(() => {
    const evidence = new Map<string, ServerPlayerEvidence>();
    let year: number | undefined;
    for (let s = 0; s * TEAMS_SECTION_PLAYERS_PER_REQUEST < requests.length; s++) {
      const result = results[`slice${s}`] as
        | { setYear: number | null; players: ServerPlayerEvidence[] }
        | Error
        | undefined;
      // Loading: the players stay "not arrived". Failed: the same, for good —
      // a suggestion is a convenience, and a broken one must not take the
      // final step down with it.
      if (!result || result instanceof Error) continue;
      if (result.setYear !== null) year = result.setYear;
      result.players.forEach((player, j) => {
        const request = requests[s * TEAMS_SECTION_PLAYERS_PER_REQUEST + j];
        if (request) evidence.set(request.key, player);
      });
    }
    return { serverEvidence: evidence, setYear: year };
  }, [results, requests]);

  const groups = useMemo(
    () =>
      inheritsSetTeam
        ? []
        : buildTeamsGroups({
        cards,
        rows,
        serverEvidence,
        setYear,
        linkedTeamNameById,
        currentYear: new Date().getFullYear(),
      }),
    [cards, rows, serverEvidence, setYear, linkedTeamNameById, inheritsSetTeam],
  );

  const answers = useMemo(
    () => teamAnswersByCard(groups, choices, cards.length),
    [groups, choices, cards.length],
  );
  const reported = useRef<Array<TeamAnswer | undefined> | null>(null);
  useEffect(() => {
    if (reported.current && sameTeamAnswers(reported.current, answers)) return;
    reported.current = answers;
    onAnswersChange(answers);
  }, [answers, onAnswersChange]);

  if (groups.length === 0) return null;
  const teamlessCount = groups.reduce((n, g) => n + g.cards.length, 0);

  return (
    <section aria-labelledby={headingId} className="border-t border-gray-800 pt-3">
      {/* Polite, so a count that moves (the operator went back and changed a
          Names decision) is said without interrupting. Copy: Jason-approved
          "K cards have no team yet". */}
      <h3
        id={headingId}
        aria-live="polite"
        className="text-sm font-normal text-gray-200"
      >
        <span className="tabular-nums">{teamlessCount}</span>{" "}
        {teamlessCount === 1 ? "card has" : "cards have"} no team yet
      </h3>
      <ul className="mt-1 divide-y divide-gray-800">
        {groups.map((group, groupIndex) => (
          <TeamsLine
            key={group.key}
            group={group}
            choice={effectiveChoice(group, choices[group.key])}
            onChoose={(choice) => onChoose(group.key, choice)}
            disabled={disabled}
            radioClass={(choiceIndex) => fieldClass(`team-${groupIndex}-${choiceIndex}`)}
          />
        ))}
      </ul>
    </section>
  );
}

function TeamsLine({
  group,
  choice,
  onChoose,
  disabled,
  radioClass,
}: {
  group: TeamsGroup;
  choice: GroupChoice;
  onChoose: (choice: GroupChoice) => void;
  disabled: boolean;
  radioClass: (choiceIndex: number) => string;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const owner = lineOwner(group);
  const items = lineChoices(group);
  const checkedId = choiceId(choice);
  const first = group.cards[0];

  const pick = (index: number, moveFocus: boolean) => {
    if (disabled) return;
    const item = items[index];
    onChoose(item.choice);
    if (moveFocus) {
      groupRef.current
        ?.querySelector<HTMLButtonElement>(`[data-choice-index="${index}"]`)
        ?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = items.findIndex((item) => item.id === checkedId);
    const from = current === -1 ? 0 : current;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (from + 1) % items.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (from - 1 + items.length) % items.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = items.length - 1;
    }
    if (next === null) return;
    event.preventDefault();
    pick(next, true);
  };

  return (
    <li className="py-2 sm:grid sm:grid-cols-[minmax(0,11rem)_auto_minmax(0,1fr)] sm:items-start sm:gap-x-2">
      <div className="min-w-0">
        <p className="truncate text-sm text-gray-100" title={owner}>
          {group.players.length > 0 ? group.players.join(" & ") : first.cardName}
        </p>
        {group.cards.length === 1 ? (
          <p className="truncate text-xs text-gray-400">
            #{first.cardNumber}
            {group.players.length > 0 ? ` · ${first.cardName}` : ""}
          </p>
        ) : (
          <details className="text-xs text-gray-400">
            <summary className="cursor-pointer rounded hover:text-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]">
              <span className="tabular-nums">{group.cards.length}</span> cards
            </summary>
            <ul aria-label={`Cards for ${owner}`} className="mt-1 space-y-0.5 pl-3">
              {group.cards.map((card) => (
                <li key={card.index} className="truncate">
                  #{card.cardNumber} · {card.cardName}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      {/* The line's grammar — "Johnny Bench → Reds". Decoration to a screen
          reader, which hears the radio group's own name instead. */}
      <span aria-hidden="true" className="hidden pt-0.5 text-sm text-gray-500 sm:block">
        →
      </span>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label={`Team for ${owner}`}
        onKeyDown={onKeyDown}
        className="mt-1.5 flex flex-wrap gap-1.5 sm:mt-0"
      >
        {items.map((item, index) => {
          const checked = item.id === checkedId;
          const isTeam = item.option !== undefined;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              data-choice-index={index}
              aria-checked={checked}
              aria-label={`${item.label} — ${owner}`}
              aria-disabled={disabled || undefined}
              tabIndex={checked ? 0 : -1}
              onClick={() => pick(index, false)}
              onKeyDown={(event) => activateOnEnter(event, () => pick(index, false), disabled)}
              // py-1 on text-xs keeps every chip at WCAG 2.5.8's 24px floor.
              className={[
                radioClass(index),
                "inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900",
                isTeam
                  ? checked
                    ? "border-[#00D558] bg-[#00D558]/10 text-gray-100"
                    : "border-gray-700 bg-gray-800 text-gray-200 hover:border-gray-500"
                  : checked
                    ? "border-gray-300 text-gray-100"
                    : "border-dashed border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-300",
                disabled ? "cursor-not-allowed opacity-60" : "",
              ].join(" ")}
            >
              {/* 1.4.1 — checked is not colour alone. Outside the label text,
                  so the words a flow or a voice user matches are unchanged. */}
              {checked && (
                <span aria-hidden="true" className={isTeam ? "text-[#00D558]" : ""}>
                  ✓
                </span>
              )}
              {item.option ? <TeamOptionLabel option={item.option} /> : <span>{item.label}</span>}
            </button>
          );
        })}
      </div>
    </li>
  );
}

/** A team choice in its livery: a swatch, then each team's name in its colour. */
function TeamOptionLabel({ option }: { option: TeamOption }) {
  const swatch = swatchColor(option.refs[0]?.colors);
  return (
    <>
      {swatch && (
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 shrink-0 rounded-full ring-1 ring-gray-600"
          style={{ backgroundColor: swatch }}
        />
      )}
      <span className="truncate">
        {option.refs.map((ref, i) => {
          const color = liveryTextColor(ref.colors);
          return (
            <span key={ref.key}>
              {i > 0 && " + "}
              <span style={color ? { color } : undefined}>{ref.label}</span>
            </span>
          );
        })}
      </span>
    </>
  );
}
