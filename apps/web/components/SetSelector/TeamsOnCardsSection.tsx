import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useQueries, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { activateOnEnter } from "../../lib/dom/activate-on-enter";
import { contrastRatio, normalizeHexColor } from "../../lib/print/contrast";
import { teamFullName } from "../../lib/teams/team-name";
import { useFieldTestClass } from "../../src/hooks/useFieldTestClass";
import TeamPicker, { type TeamPickerLabels } from "./TeamPicker";
import {
  addOtherTeam,
  buildTeamsGroups,
  cardChoiceKey,
  chooseKind,
  effectiveCardChoice,
  effectiveChoice,
  evidenceRequests,
  extraTeamIds,
  hasCardOverride,
  MAX_CARD_TEAMS,
  sameTeamAnswers,
  teamAnswersByCard,
  teamIdKey,
  teamNameRequests,
  TEAMS_SECTION_MAX_NAME_REQUESTS,
  TEAMS_SECTION_MAX_REQUESTS,
  TEAMS_SECTION_NAMES_PER_REQUEST,
  TEAMS_SECTION_PLAYERS_PER_REQUEST,
  toggleTeam,
  type GroupChoice,
  type PreviewCardForTeams,
  type ServerPlayerEvidence,
  type ServerTeam,
  type TeamAnswer,
  type TeamRef,
  type TeamsGroup,
  type TeamsReviewRow,
} from "./teams-on-cards";

/**
 * NEO-335 — the entity review wizard's Teams step ("Cards with no team").
 *
 * The cards the operator is about to save that will land with no team, one
 * line per player set: a pre-filled team when the evidence gives exactly one
 * answer, unselected teams when it gives several, "Other team…" for a team
 * the evidence never offered, "No team on this card", and "Leave for later"
 * (the default when there is no evidence). Deciding lives in
 * `teams-on-cards.ts`; this component reads the server's evidence, draws the
 * lines and reports the answers up.
 *
 * It never gates the save: a line left for later saves teamless, which is
 * exactly what happened before this step existed, and the attention walker
 * picks it up after the save.
 *
 * Renders nothing when no card is teamless — and still reports an all-empty
 * answer list, so an answer given before the operator went back and changed a
 * Names-phase decision cannot outlive the card it was given for. The step's
 * subtitle and intro line ("Pick a team for each card, or leave it for
 * later.") are the wizard's; this component draws the lines below them.
 *
 * ## The line, Phase 2
 *
 *  - One-team lines are an APG radio group (pills). A card with several
 *    people on it is MULTI-select (C4): its team chips are checkboxes
 *    (square markers, so the shape says which kind of line it is), up to
 *    `MAX_CARD_TEAMS`, and "No team" / "Leave for later" are pressed toggles.
 *  - "Other team…" (C1) opens the one-field `TeamPicker` under the line, ready
 *    to type. A name nothing matches opens the New Team dialog; the team is
 *    created there, at once, and joins the line selected. Only one picker is
 *    open at a time, so its accessible names never collide.
 *  - A grouped line's "N cards" expander lets one card take its own answer
 *    (C3) with the same controls, and hand it back with "Match the others".
 *  - A card whose listing named a team NB could not resolve shows that name
 *    ("Marketplace says: …") and is never pre-filled (invariant 8).
 *  - `showSetTeamHint` (C7) points at the set-level team when the host
 *    judges the step long and the set has none.
 *
 * ## Keyboard and screen readers
 *
 * One Tab stop per control group (roving tabindex). In a radio group the
 * arrows move the selection with focus and wrap; in a multi line they move
 * focus only, and Enter or Space toggles. Enter chooses through
 * `activateOnEnter`, which also keeps the key off the wizard's own Enter.
 * Every control's accessible name starts with its visible words and ends with
 * whose line it is, so the names stay unique across lines (Maestro matches
 * `id:` as an unanchored regex). Focus is never taken on arrival.
 */

/** The chip ground, for the livery contrast check. Tailwind v4 gray-800. */
const CHIP_GROUND = "#1e2939";
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

// Copy. OTHER_LABEL, NONE_LABEL, SET_TEAM_HINT are Jason-approved (NEO-335
// Phase 2). The rest are drafts awaiting sign-off, flagged in the build
// report.
const SET_TEAM_HINT =
  "Most of these share one team? Set a whole-set team in Set details and every new card gets it.";
const NONE_LABEL = "No team on this card";
const LATER_LABEL = "Leave for later";
const OTHER_LABEL = "Other team…";
const OWN_TEAM_LABEL = "Different team…";
const MATCH_LINE_LABEL = "Match the others";
/** The walker's existing wording (MissingTeamFixer) for a listing's team string. */
const LISTED_PREFIX = "Marketplace says:";
const CHECKING_LABEL = "Checking teams…";
const SUGGESTED_LABEL = "Teams suggested";
const CAP_NOTE = `That is the limit of ${MAX_CARD_TEAMS} teams on one card. Remove one to add another.`;
const FOREIGN_NOTE = "That team’s from another sport, so it can’t go on these cards.";

/**
 * The Other-team picker's four container names. Only one is ever open, but
 * they are worded apart from TeamPicker's defaults anyway, sharing no
 * substring with them in either direction (NEO-277's rule), so a flow's
 * `id: "Add team"` can never land here.
 */
const OTHER_TEAM_PICKER_LABELS: TeamPickerLabels = {
  root: "Find another team",
  trigger: "Look up a team",
  search: "Team name to find",
  results: "Teams that match",
};

type ControlItem =
  | { id: string; kind: "team"; ref: TeamRef; label: string }
  | { id: string; kind: "none" | "later"; label: string };

function lineItems(refs: TeamRef[]): ControlItem[] {
  return [
    ...refs.map((ref) => ({ id: `team:${ref.key}`, kind: "team" as const, ref, label: ref.label })),
    { id: "none", kind: "none", label: NONE_LABEL },
    { id: "later", kind: "later", label: LATER_LABEL },
  ];
}

function isChecked(item: ControlItem, choice: GroupChoice): boolean {
  if (item.kind === "team") return choice.kind === "teams" && choice.refKeys.includes(item.ref.key);
  return choice.kind === item.kind;
}

/** Whose line it is, in words — the second half of every control's name. */
function lineOwner(group: TeamsGroup): string {
  if (group.players.length > 0) {
    const who = group.players.join(" & ");
    return group.cards.length > 1 ? `${who}, ${group.cards.length} cards` : who;
  }
  const card = group.cards[0];
  return `#${card.cardNumber} ${card.cardName}`;
}

type SuggestionResult = {
  setYear: number | null;
  sportId?: Id<"selectorOptions"> | null;
  setLeagueId?: Id<"leagues"> | null;
  players: ServerPlayerEvidence[];
  teamNames?: Array<{ teams: ServerTeam[] }>;
};

type SuggestionQuery = {
  query: typeof api.cardChecklist.teamSuggestionsForPreview;
  args: {
    selectorOptionId: Id<"selectorOptions">;
    players: Array<{ playerId?: Id<"players">; name?: string }>;
    teamNames?: string[];
  };
};

export default function TeamsOnCardsSection({
  selectorOptionId,
  cards,
  rows,
  linkedTeamNameById,
  choices,
  onChoose,
  onAnswersChange,
  settledIndexes,
  disabled = false,
  showSetTeamHint = false,
}: {
  /** The node the cards will be saved under — the server reads the set from it. */
  selectorOptionId: Id<"selectorOptions">;
  /** The confirmed preview cards, in preview order. */
  cards: readonly PreviewCardForTeams[];
  /** The review batch, every row decided. */
  rows: readonly TeamsReviewRow[];
  /** Linked team id → full name, for a team the operator linked in the Names phase. */
  linkedTeamNameById: ReadonlyMap<string, string>;
  /**
   * The operator's own picks: by line (`TeamsGroup.key`) and by card
   * (`cardChoiceKey`). Absent = the default. The host stores whatever
   * `onChoose` hands it, verbatim.
   */
  choices: Readonly<Record<string, GroupChoice>>;
  onChoose: (key: string, choice: GroupChoice) => void;
  /** Every card's answer, positionally aligned with `cards`. */
  onAnswersChange: (answers: Array<TeamAnswer | undefined>) => void;
  /**
   * Preview positions whose team is already settled, so they are not asked
   * about: a re-synced existing row that carries a team (or a "no team"
   * answer, or a pending team name), which the commit keeps; and, under a
   * node with a set-level team (NEO-277), a card that will be a NEW row,
   * which the commit gives that team. The parent decides which is which —
   * it holds the diff that matched each card to a stored row.
   */
  settledIndexes?: readonly number[];
  /** A commit is in flight; the choices hold still. */
  disabled?: boolean;
  /**
   * C7 — show the whole-set team hint. The host decides (the step is long
   * and the set has no set-level team); this only draws it.
   */
  showSetTeamHint?: boolean;
}) {
  const fieldClass = useFieldTestClass();
  const settled = useMemo(
    () => (settledIndexes && settledIndexes.length > 0 ? new Set(settledIndexes) : undefined),
    [settledIndexes],
  );

  const requests = useMemo(
    () =>
      evidenceRequests(cards, rows, settled).slice(
        0,
        TEAMS_SECTION_PLAYERS_PER_REQUEST * TEAMS_SECTION_MAX_REQUESTS,
      ),
    [cards, rows, settled],
  );
  const nameRequests = useMemo(
    () =>
      teamNameRequests(cards, rows, settled).slice(
        0,
        TEAMS_SECTION_NAMES_PER_REQUEST * TEAMS_SECTION_MAX_NAME_REQUESTS,
      ),
    [cards, rows, settled],
  );
  const anyTeamless = useMemo(
    () => buildTeamsGroups({
      cards,
      rows,
      serverEvidence: new Map(),
      setYear: undefined,
      linkedTeamNameById: new Map(),
      currentYear: 0,
      settled,
    }).length > 0,
    [cards, rows, settled],
  );

  // Player slices and name slices are separate calls, so a name lookup never
  // stacks on a full player slice's read budget. With neither, one empty call
  // still fetches the set's sport (the team picker files under it).
  const queries = useMemo(() => {
    const out: Record<string, SuggestionQuery> = {};
    for (let i = 0; i < requests.length; i += TEAMS_SECTION_PLAYERS_PER_REQUEST) {
      out[`p${i / TEAMS_SECTION_PLAYERS_PER_REQUEST}`] = {
        query: api.cardChecklist.teamSuggestionsForPreview,
        args: {
          selectorOptionId,
          players: requests
            .slice(i, i + TEAMS_SECTION_PLAYERS_PER_REQUEST)
            .map((r) => (r.playerId ? { playerId: r.playerId } : { name: r.name ?? "" })),
        },
      };
    }
    for (let i = 0; i < nameRequests.length; i += TEAMS_SECTION_NAMES_PER_REQUEST) {
      out[`n${i / TEAMS_SECTION_NAMES_PER_REQUEST}`] = {
        query: api.cardChecklist.teamSuggestionsForPreview,
        args: {
          selectorOptionId,
          players: [],
          teamNames: nameRequests
            .slice(i, i + TEAMS_SECTION_NAMES_PER_REQUEST)
            .map((r) => r.name),
        },
      };
    }
    if (anyTeamless && Object.keys(out).length === 0) {
      out.meta = {
        query: api.cardChecklist.teamSuggestionsForPreview,
        args: { selectorOptionId, players: [] },
      };
    }
    return out;
  }, [requests, nameRequests, selectorOptionId, anyTeamless]);
  const results = useQueries(queries);

  const { serverEvidence, teamNameEvidence, setYear, sportId, setLeagueId } = useMemo(() => {
    // Loading: the entries stay "not arrived". Failed: the same, for good —
    // a suggestion is a convenience, and a broken one must not take the step
    // down with it.
    const answered = (key: string): SuggestionResult | null => {
      const result = results[key] as SuggestionResult | Error | undefined;
      return !result || result instanceof Error ? null : result;
    };
    const evidence = new Map<string, ServerPlayerEvidence>();
    for (let s = 0; s * TEAMS_SECTION_PLAYERS_PER_REQUEST < requests.length; s++) {
      answered(`p${s}`)?.players.forEach((player, j) => {
        const request = requests[s * TEAMS_SECTION_PLAYERS_PER_REQUEST + j];
        if (request) evidence.set(request.key, player);
      });
    }
    const names = new Map<string, ServerTeam[]>();
    for (let s = 0; s * TEAMS_SECTION_NAMES_PER_REQUEST < nameRequests.length; s++) {
      (answered(`n${s}`)?.teamNames ?? []).forEach((entry, j) => {
        const request = nameRequests[s * TEAMS_SECTION_NAMES_PER_REQUEST + j];
        if (request) names.set(request.key, entry.teams);
      });
    }
    // The set's facts are the same in every call; any answered one says them.
    const facts = Object.keys(results)
      .map(answered)
      .filter((r): r is SuggestionResult => r !== null);
    return {
      serverEvidence: evidence,
      teamNameEvidence: names,
      setYear: facts.find((r) => r.setYear !== null)?.setYear ?? undefined,
      sportId: facts.find((r) => r.sportId)?.sportId ?? undefined,
      setLeagueId: facts.find((r) => r.setLeagueId)?.setLeagueId ?? null,
    };
  }, [results, requests, nameRequests]);

  const groups = useMemo(
    () =>
      buildTeamsGroups({
        cards,
        rows,
        serverEvidence,
        setYear,
        linkedTeamNameById,
        currentYear: new Date().getFullYear(),
        settled,
        teamNameEvidence,
        setLeagueId,
      }),
    [
      cards,
      rows,
      serverEvidence,
      setYear,
      linkedTeamNameById,
      settled,
      teamNameEvidence,
      setLeagueId,
    ],
  );

  // Teams found with "Other team…": one read for their names and livery,
  // and the sport check the commit would otherwise fail the whole save on.
  const extraIds = useMemo(() => extraTeamIds(choices), [choices]);
  const extraRows = useQuery(api.teams.getManyByIds, extraIds.length > 0 ? { ids: extraIds } : "skip");
  const { extraRefById, blocked } = useMemo(() => {
    const refs = new Map<string, TeamRef>();
    const foreign = new Set<string>();
    for (const team of extraRows ?? []) {
      refs.set(team._id, {
        key: teamIdKey(team._id),
        label: teamFullName(team),
        ...(team.colors ? { colors: team.colors } : {}),
        teamId: team._id,
      });
      if (sportId && team.sportId !== sportId) foreign.add(team._id);
    }
    return { extraRefById: refs, blocked: foreign };
  }, [extraRows, sportId]);

  const answers = useMemo(
    () => teamAnswersByCard(groups, choices, cards.length, blocked),
    [groups, choices, cards.length, blocked],
  );
  const reported = useRef<Array<TeamAnswer | undefined> | null>(null);
  useEffect(() => {
    if (reported.current && sameTeamAnswers(reported.current, answers)) return;
    reported.current = answers;
    onAnswersChange(answers);
  }, [answers, onAnswersChange]);

  const shown = groups.length > 0;

  /** The choice key whose "Other team…" picker is open; one at a time. */
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  /** A chip to focus once it renders (after an Other-team pick, or a new card row). */
  const [focusTarget, setFocusTarget] = useState<{ choiceKey: string; itemId?: string } | null>(
    null,
  );

  if (!shown) return null;
  // ONE status for the whole section, never one per line: a line per player
  // set can be dozens, and a screen reader reading "checking" for each is
  // noise. Empty when nothing was asked of the server.
  const anyLoading = groups.some((g) => g.loading);
  const asked = requests.length > 0 || nameRequests.length > 0;
  const loadStatus = anyLoading ? CHECKING_LABEL : asked ? SUGGESTED_LABEL : "";

  const rowProps = (group: TeamsGroup, choiceKey: string, choice: GroupChoice) => ({
    group,
    choiceKey,
    choice,
    refs: lineRefs(group, choice, extraRefById),
    blocked,
    disabled,
    sportId,
    pickerOpen: pickerFor === choiceKey,
    onTogglePicker: () => setPickerFor((open) => (open === choiceKey ? null : choiceKey)),
    onChoose: (next: GroupChoice) => onChoose(choiceKey, next),
    onPicked: (teamId: Id<"teams">) => {
      onChoose(choiceKey, addOtherTeam(group, choice, teamId));
      setPickerFor(null);
      setFocusTarget({ choiceKey, itemId: `team:${teamIdKey(teamId)}` });
    },
    focusItemId: focusTarget?.choiceKey === choiceKey ? (focusTarget.itemId ?? "") : undefined,
    onFocused: () => setFocusTarget(null),
  });

  return (
    // The step's subtitle ("Cards with no team") and intro line are the
    // wizard's; this draws the lines under them.
    <div>
      {showSetTeamHint && (
        // Quiet and beside the work, not a banner: it is a shortcut for the
        // operator who has just counted thirty identical lines, and a
        // no-op for everyone else.
        <p className="mt-1.5 border-l-2 border-[#00B7FF]/70 pl-2 text-xs text-gray-300">
          {SET_TEAM_HINT}
        </p>
      )}
      {/* role="status" implies polite; no explicit aria-live (house pattern).
          Always mounted, so its first message is announced reliably. */}
      <p role="status" className="sr-only">
        {loadStatus}
      </p>
      <ul className="mt-1 divide-y divide-gray-800">
        {groups.map((group, groupIndex) => {
          const lineChoice = effectiveChoice(group, choices[group.key]);
          return (
            <TeamsLine
              key={group.key}
              group={group}
              lineRow={rowProps(group, group.key, lineChoice)}
              cardRow={(index) =>
                rowProps(
                  group,
                  cardChoiceKey(group.key, index),
                  effectiveCardChoice(group, choices, index),
                )
              }
              hasOverride={(index) => hasCardOverride(group, choices, index)}
              onOwnTeam={(index) => {
                onChoose(cardChoiceKey(group.key, index), lineChoice);
                setFocusTarget({ choiceKey: cardChoiceKey(group.key, index) });
              }}
              onMatchLine={(index) => {
                const key = cardChoiceKey(group.key, index);
                onChoose(key, { kind: "line" });
                if (pickerFor === key) setPickerFor(null);
              }}
              disabled={disabled}
              markerClass={(suffix) => fieldClass(`team-${groupIndex}-${suffix}`)}
            />
          );
        })}
      </ul>
    </div>
  );
}

/** The line's chips: its own evidence, then the teams found with "Other team…". */
function lineRefs(
  group: TeamsGroup,
  choice: GroupChoice,
  extraRefById: ReadonlyMap<string, TeamRef>,
): TeamRef[] {
  if (choice.kind === "line" || !choice.extra?.length) return group.refs;
  const have = new Set(group.refs.map((r) => r.key));
  const extras = choice.extra
    .filter((id) => !have.has(teamIdKey(id)))
    .map((id) => extraRefById.get(id) ?? { key: teamIdKey(id), label: "Loading…", teamId: id });
  return [...group.refs, ...extras];
}

type ChoiceRowProps = {
  group: TeamsGroup;
  choiceKey: string;
  choice: GroupChoice;
  refs: TeamRef[];
  blocked: ReadonlySet<string>;
  disabled: boolean;
  sportId: Id<"selectorOptions"> | undefined;
  pickerOpen: boolean;
  onTogglePicker: () => void;
  onChoose: (choice: GroupChoice) => void;
  onPicked: (teamId: Id<"teams">) => void;
  /** Focus this item once rendered; "" = the row's tab stop. */
  focusItemId: string | undefined;
  onFocused: () => void;
};

function TeamsLine({
  group,
  lineRow,
  cardRow,
  hasOverride,
  onOwnTeam,
  onMatchLine,
  disabled,
  markerClass,
}: {
  group: TeamsGroup;
  lineRow: ChoiceRowProps;
  cardRow: (index: number) => ChoiceRowProps;
  hasOverride: (index: number) => boolean;
  onOwnTeam: (index: number) => void;
  onMatchLine: (index: number) => void;
  disabled: boolean;
  markerClass: (suffix: string) => string;
}) {
  const owner = lineOwner(group);
  const first = group.cards[0];
  const overrides = group.cards.filter((card) => hasOverride(card.index)).length;

  return (
    <li className="py-2.5 sm:grid sm:grid-cols-[minmax(0,11rem)_auto_minmax(0,1fr)] sm:items-start sm:gap-x-2">
      <div className="min-w-0">
        {/* Wraps rather than truncating: a title tooltip is mouse-only, and
            "Ken Griffey Jr. & Ken Griffey Sr." cut short is the one part an
            operator needed. */}
        <p className="break-words text-sm text-gray-100">
          {group.players.length > 0 ? group.players.join(" & ") : first.cardName}
        </p>
        {group.cards.length === 1 && (
          <p className="break-words text-xs text-gray-400">
            #{first.cardNumber}
            {group.players.length > 0 ? ` · ${first.cardName}` : ""}
          </p>
        )}
        {group.listedNames.length > 0 && (
          // Invariant 8 — the listing's claim, shown so the operator knows why
          // nothing is pre-filled. Plain text, never a chip: a marketplace
          // string is never something a click turns into a team row.
          <p className="mt-0.5 break-words text-xs text-gray-400">
            {LISTED_PREFIX}{" "}
            <span className="text-gray-200">{group.listedNames.join(", ")}</span>
          </p>
        )}
      </div>
      {/* The line's grammar — "Johnny Bench → Reds". Decoration to a screen
          reader, which hears the group's own name instead. */}
      <span aria-hidden="true" className="hidden pt-1 text-sm text-gray-500 sm:block">
        →
      </span>
      <div className="mt-1.5 min-w-0 sm:mt-0">
        <ChoiceRow {...lineRow} owner={owner} markerClass={(s) => markerClass(`l-${s}`)} />
      </div>
      {group.cards.length > 1 && (
        <details
          // Opens itself when a card takes its own answer, so that answer is
          // never out of sight; the summary says so even when collapsed.
          open={overrides > 0 || undefined}
          className="mt-1.5 text-xs text-gray-400 sm:col-span-3"
        >
          {/* py-1 -my-1: a 24px target (SC 2.5.8) without moving the line. */}
          <summary className="-my-1 w-fit cursor-pointer rounded py-1 hover:text-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]">
            <span className="tabular-nums">{group.cards.length}</span> cards
            {overrides > 0 && (
              <span>
                {" "}
                (<span className="tabular-nums">{overrides}</span>{" "}
                {overrides === 1 ? "with its own team" : "with their own team"})
              </span>
            )}
          </summary>
          <ul aria-label={`Cards for ${owner}`} className="mt-1.5 space-y-2 border-l border-gray-700 pl-3">
            {group.cards.map((card, cardIdx) => {
              const own = hasOverride(card.index);
              const cardOwner = `#${card.cardNumber} ${card.cardName}`;
              return (
                <li key={card.index} className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className="break-words text-gray-300">
                      #{card.cardNumber} · {card.cardName}
                    </span>
                    {/* ONE button that flips between the two actions, so
                        focus stays put when it does. */}
                    <button
                      type="button"
                      aria-label={`${own ? MATCH_LINE_LABEL : OWN_TEAM_LABEL} — ${cardOwner}`}
                      aria-disabled={disabled || undefined}
                      onClick={() => {
                        if (disabled) return;
                        if (own) onMatchLine(card.index);
                        else onOwnTeam(card.index);
                      }}
                      onKeyDown={(event) =>
                        activateOnEnter(
                          event,
                          () => (own ? onMatchLine(card.index) : onOwnTeam(card.index)),
                          disabled,
                        )
                      }
                      className={[
                        markerClass(`c${cardIdx}-own`),
                        "-my-1 rounded py-1 text-xs text-gray-400 underline decoration-dotted underline-offset-2 hover:text-[#00B7FF] focus:outline-none focus-visible:text-[#00B7FF] focus-visible:ring-2 focus-visible:ring-[#00B7FF]",
                        disabled ? "cursor-not-allowed opacity-60" : "",
                      ].join(" ")}
                    >
                      {own ? MATCH_LINE_LABEL : OWN_TEAM_LABEL}
                    </button>
                  </div>
                  {own && (
                    <div className="mt-1">
                      <ChoiceRow
                        {...cardRow(card.index)}
                        owner={cardOwner}
                        markerClass={(s) => markerClass(`c${cardIdx}-${s}`)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </li>
  );
}

/**
 * One set of answers — a line's, or one card's inside it: the chips, then
 * "Other team…" and its picker.
 */
function ChoiceRow({
  group,
  choiceKey,
  choice,
  refs,
  blocked,
  disabled,
  sportId,
  pickerOpen,
  onTogglePicker,
  onChoose,
  onPicked,
  focusItemId,
  onFocused,
  owner,
  markerClass,
}: ChoiceRowProps & { owner: string; markerClass: (suffix: string) => string }) {
  const groupRef = useRef<HTMLDivElement>(null);
  const otherRef = useRef<HTMLButtonElement>(null);
  const pickerHostId = useId();
  const capNoteId = useId();
  const multi = group.multi;
  const items = lineItems(refs);
  const selectedTeams = choice.kind === "teams" ? choice.refKeys.length : 0;
  const atCap = multi && selectedTeams >= MAX_CARD_TEAMS;
  const anyBlocked = choice.kind === "teams" &&
    choice.refKeys.some((k) => k.startsWith("id:") && blocked.has(k.slice(3)));

  // Roving tab stop: the checked item (the first checked, in a multi line),
  // else the first item. In a multi line the operator's own focus moves it.
  const firstChecked = items.findIndex((item) => isChecked(item, choice));
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const tabStop =
    multi && focusIdx !== null && focusIdx < items.length
      ? focusIdx
      : firstChecked === -1
        ? 0
        : firstChecked;

  const itemDisabled = (item: ControlItem) =>
    disabled ||
    (item.kind === "team" &&
      ((atCap && !isChecked(item, choice)) ||
        (item.ref.teamId !== undefined && blocked.has(item.ref.teamId))));

  const focusItem = (index: number) =>
    groupRef.current?.querySelector<HTMLButtonElement>(`[data-choice-index="${index}"]`)?.focus();

  useEffect(() => {
    if (focusItemId === undefined) return;
    const index = focusItemId ? items.findIndex((item) => item.id === focusItemId) : tabStop;
    if (index === -1) return; // not rendered yet — the next render tries again
    focusItem(index);
    onFocused();
  });

  const activate = (index: number) => {
    const item = items[index];
    if (itemDisabled(item)) return;
    if (item.kind === "team") onChoose(toggleTeam(group, choice, item.ref.key));
    else if (multi && choice.kind === item.kind) onChoose(chooseKind(choice, "later"));
    else onChoose(chooseKind(choice, item.kind));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = multi ? (focusIdx ?? tabStop) : tabStop;
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
    if (multi) {
      // A multi line moves focus only; Enter or Space toggles.
      setFocusIdx(next);
      focusItem(next);
      return;
    }
    // A radio group moves the selection with focus (APG). A disabled radio
    // is skipped by nothing: there are none in a one-team line.
    activate(next);
    focusItem(next);
  };

  const otherDisabled = disabled || !sportId || atCap;

  return (
    <div className="flex flex-wrap items-start gap-1.5">
      <div
        ref={groupRef}
        role={multi ? "group" : "radiogroup"}
        aria-label={multi ? `Teams for ${owner}` : `Team for ${owner}`}
        // Its suggestion is still on the way: the choices may change under
        // the operator. The section's one status line says so in words.
        aria-busy={group.loading || undefined}
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-wrap gap-1.5"
      >
        {items.map((item, index) => {
          const checked = isChecked(item, choice);
          const isTeam = item.kind === "team";
          const off = itemDisabled(item);
          const role = !multi ? "radio" : isTeam ? "checkbox" : undefined;
          return (
            <button
              key={item.id}
              type="button"
              role={role}
              data-choice-index={index}
              {...(role ? { "aria-checked": checked } : { "aria-pressed": checked })}
              aria-label={`${item.label} — ${owner}`}
              aria-disabled={off || undefined}
              aria-describedby={atCap && isTeam && !checked ? capNoteId : undefined}
              tabIndex={index === tabStop ? 0 : -1}
              onFocus={() => {
                if (multi) setFocusIdx(index);
              }}
              onClick={() => activate(index)}
              onKeyDown={(event) => activateOnEnter(event, () => activate(index), off)}
              // py-1 on text-xs keeps every chip at WCAG 2.5.8's 24px floor.
              className={[
                markerClass(`${index}`),
                "inline-flex min-w-0 max-w-full items-center gap-1.5 border px-2.5 py-1 text-left text-xs",
                // Shape says the kind of line: pills pick one, squared chips
                // pick several.
                multi && isTeam ? "rounded-md" : "rounded-full",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900",
                isTeam
                  ? checked
                    ? "border-[#00D558] bg-[#00D558]/10 text-gray-100"
                    : "border-gray-500 bg-gray-800 text-gray-200 hover:border-gray-400"
                  : checked
                    ? "border-gray-300 text-gray-100"
                    : "border-dashed border-gray-500 text-gray-400 hover:border-gray-400 hover:text-gray-300",
                off ? "cursor-not-allowed opacity-60" : "",
              ].join(" ")}
            >
              {/* 1.4.1 — checked is not colour alone. Outside the label text,
                  so the words a flow or a voice user matches are unchanged. */}
              {checked ? (
                <span aria-hidden="true" className={isTeam ? "text-[#00D558]" : ""}>
                  ✓
                </span>
              ) : (
                multi &&
                isTeam && (
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px] border border-gray-400"
                  />
                )
              )}
              {item.kind === "team" ? (
                <TeamLabel teamRef={item.ref} />
              ) : (
                <span className="min-w-0 break-words">{item.label}</span>
              )}
            </button>
          );
        })}
      </div>
      <button
        ref={otherRef}
        type="button"
        aria-label={`${OTHER_LABEL} — ${owner}`}
        aria-expanded={pickerOpen}
        aria-controls={pickerOpen ? pickerHostId : undefined}
        aria-disabled={otherDisabled || undefined}
        onClick={() => {
          if (otherDisabled && !pickerOpen) return;
          onTogglePicker();
        }}
        onKeyDown={(event) =>
          activateOnEnter(event, onTogglePicker, otherDisabled && !pickerOpen)
        }
        className={[
          markerClass("other"),
          "inline-flex items-center rounded-full px-2.5 py-1 text-xs text-[#00B7FF] underline decoration-dotted underline-offset-2",
          "hover:text-[#5ED4FF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF] focus-visible:ring-offset-1 focus-visible:ring-offset-gray-900",
          otherDisabled && !pickerOpen ? "cursor-not-allowed opacity-60" : "",
        ].join(" ")}
      >
        {OTHER_LABEL}
      </button>
      {atCap && (
        <p id={capNoteId} className="w-full text-xs text-[#00B7FF]">
          {CAP_NOTE}
        </p>
      )}
      {anyBlocked && <p className="w-full text-xs text-[#FF2EB3]">{FOREIGN_NOTE}</p>}
      {pickerOpen && sportId && (
        <OtherTeamPicker
          hostId={pickerHostId}
          sportId={sportId}
          disabled={disabled}
          onPicked={onPicked}
          onDismiss={() => {
            onTogglePicker();
            setTimeout(() => otherRef.current?.focus(), 0);
          }}
          key={choiceKey}
        />
      )}
    </div>
  );
}

/**
 * The one-field team search under a line, open and ready to type. A pick —
 * an existing team, or one just made in the New Team dialog it opens —
 * goes straight to the line; the picker itself never holds a value.
 */
function OtherTeamPicker({
  hostId,
  sportId,
  disabled,
  onPicked,
  onDismiss,
}: {
  hostId: string;
  sportId: Id<"selectorOptions">;
  disabled: boolean;
  onPicked: (teamId: Id<"teams">) => void;
  onDismiss: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Open on arrival: "Other team…" already said "I want to search", so the
  // picker's own trigger would be a second press for nothing.
  useEffect(() => {
    hostRef.current
      ?.querySelector<HTMLButtonElement>(
        `button[aria-label="${OTHER_TEAM_PICKER_LABELS.trigger}"]`,
      )
      ?.click();
  }, []);

  return (
    <div
      ref={hostRef}
      id={hostId}
      className="w-full"
      onKeyDown={(event) => {
        // Escape in the search box closes the whole picker, back to
        // "Other team…". Escape anywhere else (the New Team dialog, portalled
        // but still a React child) is that control's own.
        const target = event.target as HTMLElement;
        if (
          event.key === "Escape" &&
          target.getAttribute("aria-label") === OTHER_TEAM_PICKER_LABELS.search
        ) {
          onDismiss();
        }
      }}
    >
      <TeamPicker
        value={[]}
        onChange={(next) => {
          const picked = next[next.length - 1];
          if (picked) onPicked(picked);
        }}
        sportId={sportId}
        disabled={disabled}
        labels={OTHER_TEAM_PICKER_LABELS}
      />
    </div>
  );
}

/** A team chip's label in its livery: a swatch, then the name in its colour. */
function TeamLabel({ teamRef }: { teamRef: TeamRef }) {
  const swatch = swatchColor(teamRef.colors);
  const color = liveryTextColor(teamRef.colors);
  return (
    <>
      {swatch && (
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 shrink-0 rounded-full ring-1 ring-gray-600"
          style={{ backgroundColor: swatch }}
        />
      )}
      <span className="min-w-0 break-words" style={color ? { color } : undefined}>
        {teamRef.label}
      </span>
    </>
  );
}
