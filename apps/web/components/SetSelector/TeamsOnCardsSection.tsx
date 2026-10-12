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
import { Autocomplete, focusWithoutOpening } from "../primitives/Autocomplete";
import { eraLabel } from "../../lib/teams/team-era";
import NewTeamDialog from "./NewTeamDialog";
import {
  addOtherTeam,
  buildTeamsGroups,
  cardChoiceKey,
  cardNumbersSummary,
  chooseKind,
  effectiveCardChoice,
  effectiveChoice,
  evidenceRequests,
  extraTeamIds,
  hasCardOverride,
  MAX_CARD_TEAMS,
  sameTeamAnswers,
  storedPeople,
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
 *  - "Other team…" (C1) opens ONE search field under the line, focused and
 *    ready to type — no second button to press. It searches the set's sport
 *    only (`teams.search`, the index every team picker types against), and
 *    its last option is "+ New team “…”…", which opens the existing New Team
 *    dialog: the team is created there, at once, and joins the line
 *    selected. Escape closes the list first, then the field, back on the
 *    toggle. The list is the shared `Autocomplete` layer — fixed, portalled
 *    into the wizard dialog, flipping above the field when there is no room
 *    below — so the dialog body's scroll box never clips it. Only one field
 *    is open at a time, so its accessible name never collides.
 *  - A grouped line's "N cards" expander lets one card take its own answer
 *    (C3) with the same controls, and hand it back with "Match the others".
 *  - A card whose listing named a team NB could not resolve shows that name
 *    ("Listed as: …") and is never pre-filled (invariant 8).
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

// Copy. OTHER_LABEL, NONE_LABEL, SET_TEAM_HINT are Jason-approved (NEO-335
// Phase 2). The rest are drafts awaiting sign-off, flagged in the build
// report.
const SET_TEAM_HINT =
  "Most of these share one team? Set a whole-set team in Set details and every new card gets it.";
const NONE_LABEL = "No team on this card";
const LATER_LABEL = "Leave for later";
const OTHER_LABEL = "Other team…";
const OWN_TEAM_LABEL = "Just this card…";
const MATCH_LINE_LABEL = "Match the others";
/** A listing's team string, shown as plain text (Jason, NEO-335 Phase 2). */
const LISTED_PREFIX = "Listed as:";
const CHECKING_LABEL = "Checking teams…";
const SUGGESTED_LABEL = "Teams suggested";
const CAP_NOTE = `That is the limit of ${MAX_CARD_TEAMS} teams on one card. Remove one to add another.`;
const FOREIGN_NOTE = "That team’s from another sport, so it can’t go on these cards.";

/**
 * The Other-team field's names. Kept word for word from the first build
 * (when it hosted TeamPicker), because flows may already target them: the
 * group around the field and the field itself. The picker's old "Look up a
 * team" trigger is gone — "Other team…" opens the field directly — and the
 * list is named by the shared Autocomplete ("Team name to find
 * suggestions"). None shares a substring with TeamPicker's defaults or the
 * wizard's "Search all teams", in either direction.
 */
const OTHER_TEAM_GROUP_LABEL = "Find another team";
const OTHER_TEAM_SEARCH_LABEL = "Team name to find";
/** What the empty field shows. */
const OTHER_TEAM_PLACEHOLDER = "Search or add a team…";
/** The multi line's keyboard hint, read with the group (draft copy). */
const MULTI_KEYS_HINT = "Arrow keys move, Space picks";
/** TeamPicker's create row, word for word: one name for one action. */
const newTeamOptionLabel = (name: string) => `+ New team “${name}”…`;
/** See TeamMatchSearch's SEARCH_DEBOUNCE_MS — same value, same reasoning. */
const OTHER_TEAM_SEARCH_DEBOUNCE_MS = 200;
const OTHER_TEAM_SEARCH_LIMIT = 8;

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
  return noPlayersLabel(group.cards.length);
}

/** The one line every teamless card with no players shares (copy: coordinator). */
function noPlayersLabel(count: number): string {
  return `Cards with no players (${count})`;
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
  playerlessIndexes,
  skippedPlayerNames,
  skippedTeamNames,
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
  /**
   * Preview positions whose card re-syncs a stored row the save keeps with
   * no players: they join the "Cards with no players" line whatever they
   * print. The parent decides — it holds the diff and the stored rows.
   */
  playerlessIndexes?: readonly number[];
  /**
   * Player names this set's skip records rule "not a person" (raw, as the
   * records list them). Nobody, on any card, like a name skipped in the
   * Names step.
   */
  skippedPlayerNames?: readonly string[];
  /**
   * Team names this set's skip records rule "not a team" (raw). Not a team
   * and not a listing's claim, on any card, like a name skipped in the Names
   * step: a card printing only such names is asked about here.
   */
  skippedTeamNames?: readonly string[];
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
  const people = useMemo(
    () => storedPeople(playerlessIndexes, skippedPlayerNames, skippedTeamNames),
    [playerlessIndexes, skippedPlayerNames, skippedTeamNames],
  );

  const requests = useMemo(
    () =>
      evidenceRequests(cards, rows, settled, people).slice(
        0,
        TEAMS_SECTION_PLAYERS_PER_REQUEST * TEAMS_SECTION_MAX_REQUESTS,
      ),
    [cards, rows, settled, people],
  );
  const nameRequests = useMemo(
    () =>
      teamNameRequests(cards, rows, settled, people).slice(
        0,
        TEAMS_SECTION_NAMES_PER_REQUEST * TEAMS_SECTION_MAX_NAME_REQUESTS,
      ),
    [cards, rows, settled, people],
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
      people,
    }).length > 0,
    [cards, rows, settled, people],
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
        people,
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
      people,
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

  /*
   * The wizard keeps this section MOUNTED on its later steps (titles, save)
   * under a `hidden` wrapper, so its answers keep reporting. An open
   * Other-team field — and a New Team dialog over it, which is portalled and
   * so not hidden with the wrapper — must not outlive the step it belongs
   * to. The host re-renders this component whenever it flips `hidden`, so
   * checking after every render is enough.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  // Every render on purpose: `hidden` is the host's DOM attribute, not a
  // prop, so no dependency list can name it. It settles at once — it only
  // ever sets null, and only from non-null.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pickerFor !== null && rootRef.current?.closest("[hidden]")) {
      // Closing a picker the host has just hidden: the DOM is the only place
      // that fact lives.
      setPickerFor(null);
    }
  });
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
    <div ref={rootRef}>
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
  const panelId = useId();
  /** The operator's own open/shut; until they touch it, open iff a card has its own answer. */
  const [openState, setOpenState] = useState<boolean | null>(null);
  const expanded = openState ?? overrides > 0;
  const grouped = group.cards.length > 1;

  return (
    <li className="py-2.5 sm:grid sm:grid-cols-[minmax(0,11rem)_auto_minmax(0,1fr)] sm:items-start sm:gap-x-2">
      <div className="min-w-0">
        {/* Wraps rather than truncating: a title tooltip is mouse-only, and
            "Ken Griffey Jr. & Ken Griffey Sr." cut short is the one part an
            operator needed. */}
        <p className="break-words text-sm text-gray-100">
          {group.players.length > 0 ? group.players.join(" & ") : noPlayersLabel(group.cards.length)}
        </p>
        {!grouped && (
          <p className="break-words text-xs text-gray-400">
            #{first.cardNumber} · {first.cardName}
          </p>
        )}
        {grouped && (
          // Which cards this line covers, on the line itself — numbers, then
          // the count; the list (and each card's own answer) opens below.
          // py-1 -my-1: a 24px target (SC 2.5.8) without moving the line.
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? panelId : undefined}
            onClick={() => setOpenState(!expanded)}
            onKeyDown={(event) => activateOnEnter(event, () => setOpenState(!expanded))}
            className={[
              markerClass("cards"),
              "-my-1 rounded py-1 text-left text-xs text-gray-400 hover:text-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00B7FF]",
            ].join(" ")}
          >
            <span className="break-words tabular-nums">
              {cardNumbersSummary(group.cards)} · {group.cards.length} cards
            </span>
            {overrides > 0 && (
              <span>
                {" "}
                (<span className="tabular-nums">{overrides}</span>{" "}
                {overrides === 1 ? "with its own team" : "with their own team"})
              </span>
            )}{" "}
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          </button>
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
      {grouped && expanded && (
        <ul
          id={panelId}
          aria-label={`Cards for ${owner}`}
          className="mt-2 space-y-2 border-l border-gray-700 pl-3 text-xs text-gray-400 sm:col-span-3"
        >
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
  const keysHintId = useId();
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

  /**
   * The next item from `from` in `step` direction. A radio group skips
   * `aria-disabled` chips (a blocked team), so the arrows never land on a
   * radio that cannot be selected; a multi line keeps them reachable — their
   * description says why they are held.
   */
  const nextFrom = (from: number, step: 1 | -1): number | null => {
    for (let n = 1; n <= items.length; n++) {
      const index = (((from + step * n) % items.length) + items.length) % items.length;
      if (multi || !itemDisabled(items[index])) return index;
    }
    return null;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const from = multi ? (focusIdx ?? tabStop) : tabStop;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = nextFrom(from, 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = nextFrom(from, -1);
    } else if (event.key === "Home") {
      next = nextFrom(items.length - 1, 1);
    } else if (event.key === "End") {
      next = nextFrom(0, -1);
    } else {
      return;
    }
    event.preventDefault();
    if (next === null || next === from) return;
    if (multi) {
      // A multi line moves focus only; Enter or Space toggles.
      setFocusIdx(next);
      focusItem(next);
      return;
    }
    // A radio group moves the selection with focus (APG).
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
        aria-describedby={multi ? keysHintId : undefined}
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-wrap gap-1.5"
      >
        {multi && (
          <span id={keysHintId} className="sr-only">
            {MULTI_KEYS_HINT}
          </span>
        )}
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

type OtherTeamOption =
  | { kind: "team"; teamId: Id<"teams">; label: string; era: string }
  | { kind: "create"; name: string };

/**
 * The one-field team search under a line, open and ready to type. A pick —
 * an existing team, or one just made in the New Team dialog its last option
 * opens — goes straight to the line; the field itself never holds a value.
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
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  /** The typed name the New Team dialog is open on; null when it is shut. */
  const [creating, setCreating] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), OTHER_TEAM_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // Focused on arrival: "Other team…" already said "I want to search".
  // Quietly is not needed — the list only opens once something is typed.
  useEffect(() => {
    hostRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, []);

  const typed = query.trim();
  const term = debounced.trim();
  const searched = useQuery(
    api.teams.search,
    typed && term ? { query: term, sportId, limit: OTHER_TEAM_SEARCH_LIMIT } : "skip",
  );
  const items = useMemo<OtherTeamOption[]>(() => {
    if (!typed) return [];
    const teams: OtherTeamOption[] = (searched ?? []).map((team) => ({
      kind: "team",
      teamId: team._id,
      label: teamFullName(team),
      era: eraLabel(team.yearsActive),
    }));
    // Always last, and always there once something is typed: a sport can
    // hold two teams under one name (two Winnipeg Jets), so an exact match
    // never hides it — the New Team dialog is where a second era is refused
    // or confirmed, as from TeamPicker.
    return [...teams, { kind: "create", name: typed }];
  }, [typed, searched]);

  return (
    <div
      ref={hostRef}
      id={hostId}
      role="group"
      aria-label={OTHER_TEAM_GROUP_LABEL}
      className="w-full max-w-sm"
      onKeyDown={(event) => {
        if (creating !== null) return; // the New Team dialog's keys are its own
        // Enter in the field is the field's (pick, or nothing): it never
        // reaches the wizard's own Enter handling.
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        // The list swallows its own Escape while it is open (one level at a
        // time); an Escape that reaches here closes the field, back to
        // "Other team…".
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onDismiss();
        }
      }}
    >
      <Autocomplete<OtherTeamOption>
        query={query}
        onQueryChange={setQuery}
        items={items}
        getKey={(o) => (o.kind === "team" ? o.teamId : "create")}
        getLabel={(o) => (o.kind === "team" ? o.label : newTeamOptionLabel(o.name))}
        getDescription={(o) => (o.kind === "team" && o.era ? o.era : undefined)}
        onSelect={(o) => {
          if (disabled) return;
          if (o.kind === "team") onPicked(o.teamId);
          else setCreating(o.name);
        }}
        label={OTHER_TEAM_SEARCH_LABEL}
        placeholder={OTHER_TEAM_PLACEHOLDER}
        loading={typed !== "" && (typed !== term || searched === undefined) && items.length <= 1}
        disabled={disabled}
        listMaxHeightClassName="max-h-56"
        inputGeometryClassName="p-1.5 text-sm"
      />
      {/* TeamPicker's own wording, for the same moment: the search answered
          and only "+ New team …" is left. Flows wait on it before Enter
          (which then can only mean "create"). */}
      {typed !== "" && typed === term && searched !== undefined && searched.length === 0 && (
        <p className="mt-1 px-1 text-xs text-gray-400">No matches.</p>
      )}
      {creating !== null && (
        <NewTeamDialog
          sportId={sportId}
          initialName={creating}
          onCreated={(teamId) => {
            setCreating(null);
            onPicked(teamId);
          }}
          onClose={() => {
            setCreating(null);
            // Back to the field the operator was typing in, without opening
            // its list over the line below.
            setTimeout(() => {
              const input = hostRef.current?.querySelector<HTMLInputElement>("input");
              if (input) focusWithoutOpening(input);
            }, 0);
          }}
        />
      )}
    </div>
  );
}

/**
 * A team chip's label in its livery: the NAME in the team's colour ("rows
 * say Padres in the team colour"), when that colour clears 4.5:1 on the chip;
 * otherwise the chip's own text colour. No colour dot: a round dot beside a
 * chip read as a selected radio. The ✓ is the only selection signal.
 */
function TeamLabel({ teamRef }: { teamRef: TeamRef }) {
  const color = liveryTextColor(teamRef.colors);
  return (
    <span className="min-w-0 break-words" style={color ? { color } : undefined}>
      {teamRef.label}
    </span>
  );
}
