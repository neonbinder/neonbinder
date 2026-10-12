/**
 * NEO-335 — the pure half of "K cards have no team yet": who is in the
 * section, how lines collapse, what evidence pre-fills, and what an answer
 * puts on the card. `TeamsOnCardsSection` only draws what this decides.
 *
 * `.test.tsx` because `.test.ts` is not collected under components/ (see
 * vitest.include.mjs) — the same reason entity-review-staging's test is .tsx.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import {
  addOtherTeam,
  answerForChoice,
  buildTeamsGroups,
  cardChoiceKey,
  cardNumbersSummary,
  chooseKind,
  defaultChoice,
  effectiveCardChoice,
  effectiveChoice,
  evidenceRequests,
  extraTeamIds,
  hasCardOverride,
  MAX_CARD_TEAMS,
  NO_PLAYERS_GROUP_KEY,
  sameTeamAnswers,
  storedPeople,
  teamIdKey,
  teamNameRequests,
  toggleTeam,
  teamAnswersByCard,
  teamlessCardIndexes,
  withTeamAnswer,
  type PreviewCardForTeams,
  type ServerPlayerEvidence,
  type ServerTeam,
  type StoredPeople,
  type TeamsGroup,
  type TeamsReviewRow,
} from "./teams-on-cards";

/** What a line's chips say, in order. */
const labels = (group: TeamsGroup) => group.refs.map((r) => r.label);
/** What the pre-fill says, in order; null when nothing is pre-filled. */
const suggested = (group: TeamsGroup) =>
  group.suggestion?.map((key) => group.refs.find((r) => r.key === key)!.label) ?? null;

const REDS = "team_reds" as Id<"teams">;
const YANKEES = "team_yankees" as Id<"teams">;
const PHILLIES = "team_phillies" as Id<"teams">;
const BENCH = "player_bench" as Id<"players">;

function card(
  cardNumber: string,
  players: string[],
  teams?: string[],
  cardName = `Card ${cardNumber}`,
): PreviewCardForTeams {
  return { cardNumber, cardName, players, ...(teams ? { teams } : {}) };
}

let rowCounter = 0;
function row(partial: Omit<TeamsReviewRow, "_id">): TeamsReviewRow {
  rowCounter += 1;
  return { _id: `row_${rowCounter}`, ...partial };
}

const serverTeam = (teamId: Id<"teams">, name: string) => ({ teamId, name });

function build(
  cards: PreviewCardForTeams[],
  rows: TeamsReviewRow[] = [],
  evidence: Record<string, ServerPlayerEvidence> = {},
  setYear?: number,
  extra: {
    teamNameEvidence?: Record<string, ServerTeam[]>;
    setLeagueId?: string | null;
    settled?: ReadonlySet<number>;
    people?: StoredPeople;
  } = {},
) {
  return buildTeamsGroups({
    cards,
    rows,
    serverEvidence: new Map(Object.entries(evidence)),
    setYear,
    linkedTeamNameById: new Map([[REDS, "Cincinnati Reds"]]),
    currentYear: 2026,
    ...(extra.teamNameEvidence
      ? { teamNameEvidence: new Map(Object.entries(extra.teamNameEvidence)) }
      : {}),
    ...(extra.setLeagueId !== undefined ? { setLeagueId: extra.setLeagueId } : {}),
    ...(extra.settled ? { settled: extra.settled } : {}),
    ...(extra.people ? { people: extra.people } : {}),
  });
}

const answered = (...teams: Array<[Id<"teams">, string]>): ServerPlayerEvidence => ({
  answer: { tier: "oneTeamInWindow", teams: teams.map(([id, n]) => serverTeam(id, n)) },
  candidates: [],
});
const unsure = (...teams: Array<[Id<"teams">, string]>): ServerPlayerEvidence => ({
  answer: null,
  candidates: teams.map(([id, n]) => serverTeam(id, n)),
});

describe("teamlessCardIndexes — who is in the section", () => {
  test("no team strings → in; a string with no review row resolved already → out", () => {
    const cards = [card("1", ["Johnny Bench"]), card("2", ["Pete Rose"], ["Reds"])];
    expect(teamlessCardIndexes(cards, [])).toEqual([0]);
  });

  test("every string skipped as not-a-team → in; a staged create or a link → out", () => {
    const rows = [
      row({ kind: "team", name: "Team Card", decision: { action: "skip" } }),
      row({ kind: "team", name: "Reds", decision: { action: "create", create: { name: "Reds" } } }),
      row({ kind: "team", name: "NY Yankees", decision: { action: "link", linkedTeamId: YANKEES } }),
    ];
    const cards = [
      card("1", ["A"], ["Team Card"]),
      card("2", ["B"], ["Reds"]),
      card("3", ["C"], ["NY Yankees"]),
      card("4", ["D"], ["Team Card", "Reds"]),
    ];
    expect(teamlessCardIndexes(cards, rows)).toEqual([0]);
  });

  test("the legacy single `team` counts when `teams` is empty", () => {
    expect(teamlessCardIndexes([{ cardNumber: "1", cardName: "x", team: "Reds" }], [])).toEqual(
      [],
    );
  });

  test("a position that re-syncs a stored row with a team is settled — never asked", () => {
    const cards = [card("1", ["A"]), card("2", ["B"])];
    expect(teamlessCardIndexes(cards, [], new Set([0]))).toEqual([1]);
    expect(evidenceRequests(cards, [], new Set([0]))).toEqual([
      { key: "name:b", name: "B" },
    ]);
    const groups = buildTeamsGroups({
      cards,
      rows: [],
      serverEvidence: new Map(),
      setYear: undefined,
      linkedTeamNameById: new Map(),
      currentYear: 2026,
      settled: new Set([0]),
    });
    expect(groups.map((g) => g.cards.map((c) => c.index))).toEqual([[1]]);
  });

  test("membership ignores the section's own answers", () => {
    // An answer rides beside the cards, never on them, so this stays true
    // after the operator answers — the line does not vanish.
    const cards = [card("1", ["Johnny Bench"])];
    expect(teamlessCardIndexes(cards, [])).toEqual([0]);
  });
});

describe("buildTeamsGroups — grouping", () => {
  test("same player set collapses into one line; card numbers are never the key", () => {
    const groups = build([
      card("12", ["Johnny Bench"]),
      card("12", ["Johnny Bench"]), // duplicate number, same player — still two cards
      card("40", ["Pete Rose"]),
      card("41", ["johnny  bench"]), // same person, different spelling
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].players).toEqual(["Johnny Bench"]);
    expect(groups[0].cards.map((c) => c.index)).toEqual([0, 1, 3]);
    expect(groups[1].cards.map((c) => c.index)).toEqual([2]);
  });

  test("player order on the card does not split a line", () => {
    const groups = build([card("1", ["A", "B"]), card("2", ["B", "A"])]);
    expect(groups).toHaveLength(1);
  });

  // REWRITTEN (collector review): playerless cards used to get a line each.
  // Checklists, leaders and highlights now share ONE line, keyed on having
  // no players, never on a card's name.
  test("every card with nobody on it shares one line, whatever it is called", () => {
    const groups = build([
      card("1", [], undefined, "Checklist"),
      card("2", ["Johnny Bench"]),
      card("3", [], undefined, "League Leaders"),
      card("4", [], undefined, "Checklist"),
    ]);
    expect(groups.map((g) => g.cards.map((c) => c.index))).toEqual([[0, 2, 3], [1]]);
    expect(groups[0].key).toBe(NO_PLAYERS_GROUP_KEY);
    expect(groups[0].players).toEqual([]);
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
  });

  test("a card whose only names were skipped as not-a-person joins the no-players line", () => {
    const rows = [row({ kind: "player", name: "Team Leaders", decision: { action: "skip" } })];
    const groups = build([card("1", ["Team Leaders"]), card("2", [])], rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(NO_PLAYERS_GROUP_KEY);
  });

  test("the no-players line pools its cards' listing claims and holds back every pre-fill", () => {
    const rows = [
      row({ kind: "team", name: "Bulls", decision: null }),
      row({ kind: "team", name: "Bears", decision: null }),
    ];
    const BULLS = "team_bulls" as Id<"teams">;
    const groups = build(
      [card("1", [], ["Bulls"]), card("2", [], ["Bears"]), card("3", [])],
      rows,
      {},
      undefined,
      { teamNameEvidence: { bulls: [serverTeam(BULLS, "Durham Bulls")], bears: [] } },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].listedNames).toEqual(["Bulls", "Bears"]);
    expect(labels(groups[0])).toEqual(["Durham Bulls"]);
    expect(groups[0].suggestion).toBeNull();
  });

  test("cardNumbersSummary: up to four in full, then three and a count", () => {
    const n = (...numbers: string[]) => numbers.map((cardNumber) => ({ cardNumber }));
    expect(cardNumbersSummary(n("5", "407"))).toBe("#5 · #407");
    expect(cardNumbersSummary(n("1", "2", "3", "4"))).toBe("#1 · #2 · #3 · #4");
    expect(cardNumbersSummary(n("5", "407", "512", "6", "7", "8"))).toBe("#5, #407, #512 +3");
  });

  test("a player skipped as not-a-person is nobody", () => {
    const rows = [row({ kind: "player", name: "Checklist", decision: { action: "skip" } })];
    const groups = build([card("1", ["Checklist", "Johnny Bench"]), card("2", ["Johnny Bench"])], rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].players).toEqual(["Johnny Bench"]);
  });
});

describe("buildTeamsGroups — batch evidence (i)", () => {
  test("a sibling card with the same players and a resolving team pre-fills it", () => {
    const groups = build([card("1", ["Johnny Bench"]), card("2", ["Johnny Bench"], ["Reds"])]);
    expect(groups).toHaveLength(1);
    expect(groups[0].suggestion).toEqual(["name:reds"]);
    expect(groups[0].refs).toEqual([{ key: "name:reds", label: "Reds", name: "Reds" }]);
    expect(defaultChoice(groups[0])).toEqual({ kind: "teams", refKeys: ["name:reds"] });
  });

  test("a tie between siblings stays unselected — never the first one", () => {
    const groups = build([
      card("1", ["Johnny Bench"]),
      card("2", ["Johnny Bench"], ["Reds"]),
      card("3", ["Johnny Bench"], ["Phillies"]),
    ]);
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual(["Reds", "Phillies"]);
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
  });

  test("a different player set is not evidence", () => {
    const groups = build([card("1", ["Johnny Bench"]), card("2", ["Johnny Bench", "Pete Rose"], ["Reds"])]);
    expect(groups[0].suggestion).toBeNull();
  });

  test("a staged New Team shows its composed name and answers with the row's own name", () => {
    const rows = [
      row({
        kind: "team",
        name: "Reds",
        decision: { action: "create", create: { location: "Cincinnati", name: "Reds" } },
      }),
    ];
    const groups = build([card("1", ["Johnny Bench"]), card("2", ["Johnny Bench"], ["reds"])], rows);
    expect(suggested(groups[0])).toEqual(["Cincinnati Reds"]);
    expect(answerForChoice(groups[0], defaultChoice(groups[0]))).toEqual({ teams: ["Reds"] });
  });

  test("batch outranks the server", () => {
    const groups = build(
      [card("1", ["Johnny Bench"]), card("2", ["Johnny Bench"], ["Reds"])],
      [],
      { "name:johnny bench": answered([PHILLIES, "Philadelphia Phillies"]) },
    );
    expect(suggested(groups[0])).toEqual(["Reds"]);
  });
});

describe("buildTeamsGroups — per-player evidence (ii)+(iii)", () => {
  test("a known player's server answer pre-fills by id", () => {
    const cards = [card("1", ["Johnny Bench"])];
    const [request] = evidenceRequests(cards, []);
    expect(request).toEqual({ key: "name:bench johnny", name: "Johnny Bench" });
    const groups = build(cards, [], { [request.key]: answered([REDS, "Cincinnati Reds"]) });
    expect(answerForChoice(groups[0], defaultChoice(groups[0]))).toEqual({ teamIds: [REDS] });
  });

  test("a linked player is asked for by id", () => {
    const rows = [
      row({ kind: "player", name: "J. Bench", decision: { action: "link", linkedPlayerId: BENCH } }),
    ];
    expect(evidenceRequests([card("1", ["J. Bench"])], rows)).toEqual([
      { key: `id:${BENCH}`, playerId: BENCH },
    ]);
  });

  test("evidence not arrived yet → loading, Leave for later", () => {
    const groups = build([card("1", ["Johnny Bench"])]);
    expect(groups[0].loading).toBe(true);
    expect(groups[0].refs).toEqual([]);
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
  });

  test("several server candidates stay unselected", () => {
    const cards = [card("1", ["Johnny Bench"])];
    const [request] = evidenceRequests(cards, []);
    const groups = build(cards, [], {
      [request.key]: unsure([REDS, "Cincinnati Reds"], [YANKEES, "New York Yankees"]),
    });
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual(["Cincinnati Reds", "New York Yankees"]);
  });

  test("multi-player: every player answering → the union, pre-filled", () => {
    const cards = [card("1", ["A", "B"])];
    const [a, b] = evidenceRequests(cards, []);
    const groups = build(cards, [], {
      [a.key]: answered([REDS, "Cincinnati Reds"]),
      [b.key]: answered([YANKEES, "New York Yankees"]),
    });
    // C4: a multi-player card picks several teams, both pre-ticked.
    expect(groups[0].multi).toBe(true);
    expect(suggested(groups[0])).toEqual(["Cincinnati Reds", "New York Yankees"]);
    expect(answerForChoice(groups[0], defaultChoice(groups[0]))).toEqual({
      teamIds: [REDS, YANKEES],
    });
  });

  test("multi-player: one player unsure → every offered team, unselected", () => {
    const cards = [card("1", ["A", "B"])];
    const [a, b] = evidenceRequests(cards, []);
    const groups = build(cards, [], {
      [a.key]: answered([REDS, "Cincinnati Reds"]),
      [b.key]: unsure([YANKEES, "New York Yankees"], [PHILLIES, "Philadelphia Phillies"]),
    });
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual([
      "Cincinnati Reds",
      "New York Yankees",
      "Philadelphia Phillies",
    ]);
  });

  // NEO-335 Phase 2 (C2) — REWRITTEN: Phase 1 pre-filled a created player's
  // one-team career with NO year. The window rule needs the set year: the
  // stint must cover [setYear - 1, setYear]. Same fixture, with a set year.
  test("a player created in this wizard answers from their own career, through the window", () => {
    const rows = [
      row({
        kind: "player",
        name: "Rookie Guy",
        enrichment: { careerTeams: [{ name: "Reds", fromYear: 2024 }] },
        decision: { action: "create" },
      }),
      row({
        kind: "team",
        name: "Reds",
        enrichment: { colors: { primary: "#C6011F" } },
        decision: { action: "create", create: { location: "Cincinnati", name: "Reds" } },
      }),
    ];
    const cards = [card("1", ["Rookie Guy"])];
    expect(evidenceRequests(cards, rows)).toEqual([]);
    expect(build(cards, rows)[0].suggestion).toBeNull(); // no set year → no window
    const groups = build(cards, rows, {}, 2025);
    expect(groups[0].refs[0]).toMatchObject({
      label: "Cincinnati Reds",
      name: "Reds",
      colors: { primary: "#C6011F" },
    });
  });

  // REWRITTEN (C2): "one stint in the year" became "one team in
  // [setYear-1, setYear]". At 2021 the old fixture is now a Reds/Phillies tie
  // (the Reds stint ended 2020), so the set year moves to 2022, and the
  // unchecked Yankees stint is moved INTO that window so unchecking it still
  // decides the answer.
  test("a created player's unchecked career team is not evidence; one team in the window is", () => {
    const rows = [
      row({
        kind: "player",
        name: "Traded Guy",
        enrichment: {
          careerTeams: [
            { name: "Reds", fromYear: 2018, toYear: 2020 },
            { name: "Phillies", fromYear: 2021, toYear: 2022 },
            { name: "Yankees", fromYear: 2022 },
          ],
        },
        decision: { action: "create", excludedCareerTeamNames: ["Yankees"] },
      }),
    ];
    const groups = build([card("1", ["Traded Guy"])], rows, {}, 2022);
    expect(suggested(groups[0])).toEqual(["Phillies"]);
  });
});

describe("choices and answers", () => {
  const cards = [card("1", ["Johnny Bench"]), card("2", ["Johnny Bench"], ["Reds"]), card("3", ["Pete Rose"])];
  const groups = build(cards, [], { "name:pete rose": unsure() });

  test("pre-filled line answers by default; an unknown line is left for later", () => {
    expect(teamAnswersByCard(groups, {}, cards.length)).toEqual([
      { teams: ["Reds"] },
      undefined,
      undefined,
    ]);
  });

  test("No team on this card, and Leave for later overriding a pre-fill", () => {
    const answers = teamAnswersByCard(
      groups,
      { [groups[0].key]: { kind: "later" }, [groups[1].key]: { kind: "none" } },
      cards.length,
    );
    expect(answers).toEqual([undefined, undefined, { teamNone: true }]);
  });

  test("a pick naming an option the line no longer offers falls back to the default", () => {
    expect(effectiveChoice(groups[0], { kind: "teams", refKeys: ["gone"] })).toEqual(
      defaultChoice(groups[0]),
    );
  });

  test("sameTeamAnswers", () => {
    expect(sameTeamAnswers([undefined, { teamNone: true }], [undefined, { teamNone: true }])).toBe(true);
    expect(sameTeamAnswers([], [undefined])).toBe(false);
    expect(sameTeamAnswers([{ teams: ["a"] }], [{ teams: ["b"] }])).toBe(false);
  });

  test("withTeamAnswer: unanswered card is the same object; teams replace the printed strings", () => {
    const original = card("9", ["X"], ["Team Card"]);
    expect(withTeamAnswer(original, undefined)).toBe(original);
    expect(withTeamAnswer(original, { teams: ["Reds"], teamIds: [REDS] })).toMatchObject({
      teams: ["Reds"],
      teamIds: [REDS],
      // The replacement is the operator's answer, so the commit may fill an
      // existing teamless row with it (it never does with printed strings).
      teamsAnswered: true,
    });
    const none = withTeamAnswer(original, { teamNone: true });
    expect(none).toMatchObject({ teams: ["Team Card"], teamNone: true });
    // The printed strings were NOT answered: no marker.
    expect(none).not.toHaveProperty("teamsAnswered");
    // An id-only answer leaves the printed strings unmarked too.
    expect(withTeamAnswer(original, { teamIds: [REDS] })).not.toHaveProperty("teamsAnswered");
  });
});

// ---------------------------------------------------------------------------
// Adversarial pass (NEO-335)
// ---------------------------------------------------------------------------

describe("adversarial — evidence that must NOT pre-fill", () => {
  test("a batch disagreement stops the search: the server's answer is neither pre-filled nor offered", () => {
    const groups = build(
      [
        card("1", ["Johnny Bench"]),
        card("2", ["Johnny Bench"], ["Reds"]),
        card("3", ["Johnny Bench"], ["Yankees"]),
      ],
      [],
      { "name:bench johnny": answered([PHILLIES, "Philadelphia Phillies"]) },
    );
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual(["Reds", "Yankees"]);
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
  });

  test("two siblings printing the SAME team in a different spelling are one answer, not a tie", () => {
    const groups = build([
      card("1", ["Johnny Bench"]),
      card("2", ["Johnny Bench"], ["Reds"]),
      card("3", ["Johnny Bench"], ["  reds "]),
    ]);
    expect(suggested(groups[0])).toEqual(["Reds"]);
  });

  test("a sibling settled by its stored row is still a sibling, but a skipped string on it is no evidence", () => {
    const rows = [row({ kind: "team", name: "Team Card", decision: { action: "skip" } })];
    const groups = buildTeamsGroups({
      cards: [card("1", ["Johnny Bench"]), card("2", ["Johnny Bench"], ["Team Card"])],
      rows,
      serverEvidence: new Map(),
      setYear: undefined,
      linkedTeamNameById: new Map(),
      currentYear: 2026,
      settled: new Set([1]),
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].cards.map((c) => c.index)).toEqual([0]);
    // Nothing printed resolves on the sibling, so the line falls to the
    // server — which has not answered yet.
    expect(groups[0].suggestion).toBeNull();
    expect(groups[0].loading).toBe(true);
  });

  test("multi-player: a union over the per-card cap is never pre-filled", () => {
    const names = Array.from({ length: 9 }, (_, i) => `Player ${i}`);
    const cards = [card("1", names)];
    const requests = evidenceRequests(cards, []);
    expect(requests).toHaveLength(9);
    const evidence = Object.fromEntries(
      requests.map((r, i) => [
        r.key,
        answered([`team_${i}` as Id<"teams">, `Team ${i}`]),
      ]),
    );
    const groups = build(cards, [], evidence);
    expect(groups[0].suggestion).toBeNull();
    // Every team stays a choice, capped at what a line may offer.
    expect(groups[0].refs).toHaveLength(6);
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
  });

  test("a created player and a known player on one card: the known one still loading holds the pre-fill", () => {
    const rows = [
      row({
        kind: "player",
        name: "Rookie Guy",
        enrichment: { careerTeams: [{ name: "Reds", fromYear: 2024 }] },
        decision: { action: "create" },
      }),
    ];
    const cards = [card("1", ["Rookie Guy", "Johnny Bench"])];
    const loading = build(cards, rows);
    expect(loading[0].loading).toBe(true);
    expect(loading[0].suggestion).toBeNull();

    const arrived = build(
      cards,
      rows,
      { "name:bench johnny": answered([YANKEES, "New York Yankees"]) },
      2025,
    );
    expect(arrived[0].loading).toBe(false);
    expect(answerForChoice(arrived[0], defaultChoice(arrived[0]))).toEqual({
      teamIds: [YANKEES],
      teams: ["Reds"],
    });
  });

  test("a created player whose only career team was skipped as not-a-team offers nothing", () => {
    const rows = [
      row({
        kind: "player",
        name: "Rookie Guy",
        enrichment: { careerTeams: [{ name: "Team Card", fromYear: 2024 }] },
        decision: { action: "create" },
      }),
      row({ kind: "team", name: "Team Card", decision: { action: "skip" } }),
    ];
    const groups = build([card("1", ["Rookie Guy"])], rows);
    expect(groups[0].suggestion).toBeNull();
    expect(groups[0].refs).toEqual([]);
    expect(groups[0].loading).toBe(false);
  });
});

describe("adversarial — answers are positional, never by card number", () => {
  test("one line's answer lands on every card in it, including two that share a number", () => {
    const cards = [
      card("12", ["Johnny Bench"]),
      card("12", ["Pete Rose"]),
      card("12", ["Johnny Bench"]),
    ];
    const groups = build(cards, [], {
      "name:bench johnny": unsure(),
      "name:pete rose": unsure(),
    });
    expect(groups.map((g) => g.cards.map((c) => c.index))).toEqual([[0, 2], [1]]);
    const answers = teamAnswersByCard(groups, { [groups[0].key]: { kind: "none" } }, cards.length);
    expect(answers).toEqual([{ teamNone: true }, undefined, { teamNone: true }]);
  });

  test("a position past the card count is never written (a stale group after the cards shrank)", () => {
    const groups = build([card("1", ["A"]), card("2", ["A"])], [], { "name:a": unsure() });
    const answers = teamAnswersByCard(groups, { [groups[0].key]: { kind: "none" } }, 1);
    expect(answers).toEqual([{ teamNone: true }]);
  });
});

// ---------------------------------------------------------------------------
// NEO-335 Phase 2
// ---------------------------------------------------------------------------

describe("invariant 8 — a listing's team name holds the guess back", () => {
  // A name the operator has NOT ruled on: still a claim. (A "not a team"
  // skip is an answer, not a claim — see the next describe.)
  const unruledTeam = (name: string) => row({ kind: "team", name, decision: null });

  test("a listed name blocks a server pre-fill; the line is left for later and says what was listed", () => {
    const rows = [unruledTeam("Bulls")];
    const cards = [card("1", ["Johnny Bench"], ["Bulls"])];
    const groups = build(cards, rows, {
      "name:bench johnny": answered([REDS, "Cincinnati Reds"]),
    });
    expect(groups[0].listedNames).toEqual(["Bulls"]);
    expect(groups[0].suggestion).toBeNull();
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
    // The would-be pre-fill is still a choice — the operator decides.
    expect(labels(groups[0])).toEqual(["Cincinnati Reds"]);
    expect(teamAnswersByCard(groups, {}, 1)).toEqual([undefined]);
  });

  test("a listed name blocks a batch pre-fill too", () => {
    const rows = [unruledTeam("Bulls")];
    const groups = build(
      [card("1", ["Johnny Bench"], ["Bulls"]), card("2", ["Johnny Bench"], ["Reds"])],
      rows,
    );
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual(["Reds"]);
  });

  test("a listed name blocks a created player's career pre-fill", () => {
    const rows = [
      unruledTeam("Bulls"),
      row({
        kind: "player",
        name: "Rookie Guy",
        enrichment: { careerTeams: [{ name: "Reds", fromYear: 2024 }] },
        decision: { action: "create" },
      }),
    ];
    const groups = build([card("1", ["Rookie Guy"], ["Bulls"])], rows, {}, 2025);
    expect(groups[0].suggestion).toBeNull();
  });

  test("the NB teams the listed name resolves to are offered FIRST, unselected", () => {
    const rows = [unruledTeam("Durham Bulls")];
    const cards = [card("1", ["Johnny Bench"], ["Durham Bulls"])];
    expect(teamNameRequests(cards, rows)).toEqual([
      { key: "bulls durham", name: "Durham Bulls" },
    ]);
    const BULLS = "team_bulls" as Id<"teams">;
    const groups = build(
      cards,
      rows,
      { "name:bench johnny": unsure([REDS, "Cincinnati Reds"]) },
      undefined,
      { teamNameEvidence: { "bulls durham": [serverTeam(BULLS, "Durham Bulls")] } },
    );
    expect(labels(groups[0])).toEqual(["Durham Bulls", "Cincinnati Reds"]);
    expect(groups[0].suggestion).toBeNull();
  });

  test("the listed name's lookup still on its way → the line is loading", () => {
    const rows = [unruledTeam("Bulls")];
    const groups = build([card("1", [], ["Bulls"])], rows, {}, undefined, {
      teamNameEvidence: {},
    });
    expect(groups[0].loading).toBe(true);
  });

  test("a failed team lookup is missing data: nothing pre-filled, the operator picks", () => {
    const cards: PreviewCardForTeams[] = [
      { ...card("1", ["Johnny Bench"]), teamLookup: "failed" },
      { ...card("2", ["Johnny Bench"]), teamLookup: "answered" },
    ];
    const groups = build(cards, [], {
      "name:bench johnny": answered([REDS, "Cincinnati Reds"]),
    });
    // Two lines: the claim (or its absence) is part of what a line shares.
    expect(groups).toHaveLength(2);
    expect(groups[0].lookupFailed).toBe(true);
    expect(groups[0].suggestion).toBeNull();
    expect(suggested(groups[1])).toEqual(["Cincinnati Reds"]);
  });

  test("the listed string is never written: an answer only ever names a chip", () => {
    const rows = [unruledTeam("Bulls")];
    const groups = build([card("1", ["Johnny Bench"], ["Bulls"])], rows, {
      "name:bench johnny": unsure([REDS, "Cincinnati Reds"]),
    });
    const choice = toggleTeam(groups[0], defaultChoice(groups[0]), teamIdKey(REDS));
    expect(answerForChoice(groups[0], choice)).toEqual({ teamIds: [REDS] });
  });
});

describe("invariant 8 — a name ruled \"not a team\" in this sitting is no longer a claim", () => {
  const skippedTeam = (name: string) => row({ kind: "team", name, decision: { action: "skip" } });

  test("a skipped name does not block the server pre-fill, is not shown, and is not looked up", () => {
    const rows = [skippedTeam("Team Card")];
    const cards = [card("1", ["Johnny Bench"], ["Team Card"])];
    // Still in the section: the skipped string gives the card no team.
    expect(teamlessCardIndexes(cards, rows)).toEqual([0]);
    expect(teamNameRequests(cards, rows)).toEqual([]);
    const groups = build(
      cards,
      rows,
      { "name:bench johnny": answered([REDS, "Cincinnati Reds"]) },
      undefined,
      { teamNameEvidence: {} },
    );
    expect(groups[0].listedNames).toEqual([]);
    expect(groups[0].loading).toBe(false);
    expect(suggested(groups[0])).toEqual(["Cincinnati Reds"]);
    expect(teamAnswersByCard(groups, {}, 1)).toEqual([{ teamIds: [REDS] }]);
  });

  test("a skipped name does not split the player's line or block a batch pre-fill", () => {
    const rows = [skippedTeam("Team Card")];
    const groups = build(
      [
        card("1", ["Johnny Bench"], ["Team Card"]),
        card("2", ["Johnny Bench"]),
        card("3", ["Johnny Bench"], ["Reds"]),
      ],
      rows,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].cards.map((c) => c.index)).toEqual([0, 1]);
    expect(suggested(groups[0])).toEqual(["Reds"]);
  });

  test("the other direction: an unruled name beside a skipped one still blocks, and only it is shown", () => {
    const rows = [skippedTeam("Team Card"), row({ kind: "team", name: "Bulls", decision: null })];
    const cards = [card("1", ["Johnny Bench"], ["Team Card", "Bulls"])];
    expect(teamNameRequests(cards, rows).map((r) => r.name)).toEqual(["Bulls"]);
    const groups = build(cards, rows, {
      "name:bench johnny": answered([REDS, "Cincinnati Reds"]),
    });
    expect(groups[0].listedNames).toEqual(["Bulls"]);
    expect(groups[0].suggestion).toBeNull();
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
  });

  test("the other direction: a failed lookup still blocks even when its printed name was skipped", () => {
    const rows = [skippedTeam("Team Card")];
    const cards: PreviewCardForTeams[] = [
      { ...card("1", ["Johnny Bench"], ["Team Card"]), teamLookup: "failed" },
    ];
    const groups = build(cards, rows, {
      "name:bench johnny": answered([REDS, "Cincinnati Reds"]),
    });
    expect(groups[0].listedNames).toEqual([]);
    expect(groups[0].lookupFailed).toBe(true);
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual(["Cincinnati Reds"]);
  });
});

describe("created players — the window and the set's league (C2, C2b, C8)", () => {
  const created = (name: string, careerTeams: Array<{ name: string; fromYear: number; toYear?: number }>) =>
    row({ kind: "player", name, enrichment: { careerTeams }, decision: { action: "create" } });

  test("a legend gets no pre-fill: career unselected, longest stint first", () => {
    const rows = [
      created("Old Timer", [
        { name: "Red Sox", fromYear: 1914, toYear: 1919 },
        { name: "Yankees", fromYear: 1920, toYear: 1934 },
      ]),
    ];
    const groups = build([card("1", ["Old Timer"])], rows, {}, 2026, { teamNameEvidence: {
      "red sox": [], yankees: [],
    } });
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual(["Yankees", "Red Sox"]);
  });

  test("a created legend's one-team career pre-fills only when the team is in the set's league", () => {
    const REDS_ID = "team_reds_existing" as Id<"teams">;
    const rows = [created("Legend Guy", [{ name: "Cincinnati Reds", fromYear: 1967, toYear: 1983 }])];
    const cards = [card("1", ["Legend Guy"])];
    const inLeague = build(cards, rows, {}, 2026, {
      teamNameEvidence: { "cincinnati reds": [{ teamId: REDS_ID, name: "Cincinnati Reds", rank: 0 }] },
    });
    expect(suggested(inLeague[0])).toEqual(["Cincinnati Reds"]);
    const otherLeague = build(cards, rows, {}, 2026, {
      teamNameEvidence: { "cincinnati reds": [{ teamId: REDS_ID, name: "Cincinnati Reds", rank: 2 }] },
    });
    expect(otherLeague[0].suggestion).toBeNull();
    const noLeague = build(cards, rows, {}, 2026, {
      teamNameEvidence: { "cincinnati reds": [{ teamId: REDS_ID, name: "Cincinnati Reds" }] },
    });
    expect(noLeague[0].suggestion).toBeNull();
  });

  test("invariant 8 beats the legend rule: a listing-named or failed-lookup card is not pre-filled", () => {
    const evidence = { "name:bench johnny": {
      answer: { tier: "oneTeamCareerInLeague", teams: [serverTeam(REDS, "Cincinnati Reds")] },
      candidates: [],
    } };
    const named = build(
      [card("1", ["Johnny Bench"], ["Bulls"])],
      [row({ kind: "team", name: "Bulls", decision: null })],
      evidence,
    );
    expect(named[0].suggestion).toBeNull();
    const failed = build([{ ...card("1", ["Johnny Bench"]), teamLookup: "failed" }], [], evidence);
    expect(failed[0].suggestion).toBeNull();
  });

  test("C8: a prospect's major-league org (existing team, ranked by the server) beats his affiliates", () => {
    const RAYS = "team_rays" as Id<"teams">;
    const rows = [
      created("Prospect Guy", [
        { name: "Montgomery Biscuits", fromYear: 2024, toYear: 2025 },
        { name: "Tampa Bay Rays", fromYear: 2024 },
        { name: "Durham Bulls", fromYear: 2025, toYear: 2026 },
      ]),
    ];
    const cards = [card("1", ["Prospect Guy"])];
    expect(teamNameRequests(cards, rows).map((r) => r.name)).toEqual([
      "Montgomery Biscuits",
      "Tampa Bay Rays",
      "Durham Bulls",
    ]);
    const pending = build(cards, rows, {}, 2026, { teamNameEvidence: {} });
    expect(pending[0].loading).toBe(true);
    expect(pending[0].suggestion).toBeNull();

    const groups = build(cards, rows, {}, 2026, {
      teamNameEvidence: {
        "biscuits montgomery": [],
        "bay rays tampa": [{ teamId: RAYS, name: "Tampa Bay Rays", rank: 0 }],
        "bulls durham": [],
      },
    });
    expect(suggested(groups[0])).toEqual(["Tampa Bay Rays"]);
    // The affiliates stay offered, behind the pick.
    expect(labels(groups[0])).toEqual(["Tampa Bay Rays", "Montgomery Biscuits", "Durham Bulls"]);
  });

  test("a team staged in this wizard is in the set's league when the operator filed it there", () => {
    const rows = [
      created("Rookie Guy", [
        { name: "Sydney Blue Sox", fromYear: 2024, toYear: 2025 },
        { name: "New Club", fromYear: 2025 },
      ]),
      row({
        kind: "team",
        name: "New Club",
        decision: { action: "create", create: { location: "New", name: "Club", leagueId: "league_mlb" } },
      }),
      row({
        kind: "team",
        name: "Sydney Blue Sox",
        decision: { action: "create", create: { location: "Sydney", name: "Blue Sox", leagueId: "league_abl" } },
      }),
    ];
    const groups = build([card("1", ["Rookie Guy"])], rows, {}, 2026, {
      teamNameEvidence: {},
      setLeagueId: "league_mlb",
    });
    expect(suggested(groups[0])).toEqual(["New Club"]);
  });
});

describe("choices — multi-select (C4), Other team (C1), per-card (C3)", () => {
  const multiGroup = () => {
    const cards = [card("1", ["A", "B"])];
    const [a, b] = evidenceRequests(cards, []);
    return build(cards, [], {
      [a.key]: unsure([REDS, "Cincinnati Reds"]),
      [b.key]: unsure([YANKEES, "New York Yankees"]),
    })[0];
  };

  test("a multi line toggles teams; unticking the last leaves it for later", () => {
    const group = multiGroup();
    expect(group.multi).toBe(true);
    let choice = toggleTeam(group, defaultChoice(group), teamIdKey(REDS));
    choice = toggleTeam(group, choice, teamIdKey(YANKEES));
    expect(answerForChoice(group, choice)).toEqual({ teamIds: [REDS, YANKEES] });
    choice = toggleTeam(group, toggleTeam(group, choice, teamIdKey(REDS)), teamIdKey(YANKEES));
    expect(choice).toEqual({ kind: "later" });
  });

  test("a one-team line replaces its pick", () => {
    const cards = [card("1", ["Johnny Bench"])];
    const group = build(cards, [], {
      "name:bench johnny": unsure([REDS, "Cincinnati Reds"], [YANKEES, "New York Yankees"]),
    })[0];
    expect(group.multi).toBe(false);
    const choice = toggleTeam(
      group,
      toggleTeam(group, defaultChoice(group), teamIdKey(REDS)),
      teamIdKey(YANKEES),
    );
    expect(choice).toEqual({ kind: "teams", refKeys: [teamIdKey(YANKEES)] });
  });

  test("the multi-select cap: a ninth team is refused, by toggle and by Other team", () => {
    const group = multiGroup();
    const eight = Array.from({ length: MAX_CARD_TEAMS }, (_, i) => `team_x${i}` as Id<"teams">);
    let choice = defaultChoice(group);
    for (const id of eight) choice = addOtherTeam(group, choice, id);
    expect(choice.kind === "teams" && choice.refKeys).toHaveLength(MAX_CARD_TEAMS);
    expect(toggleTeam(group, choice, teamIdKey(REDS))).toBe(choice);
    const ninth = addOtherTeam(group, choice, "team_ninth" as Id<"teams">);
    expect(ninth.kind === "teams" && ninth.refKeys).toHaveLength(MAX_CARD_TEAMS);
    expect(answerForChoice(group, ninth)?.teamIds).toHaveLength(MAX_CARD_TEAMS);
  });

  test("Other team: the team joins the line selected, survives No team and back, and answers by id", () => {
    const cards = [card("1", ["Johnny Bench"])];
    const group = build(cards, [], { "name:bench johnny": unsure([REDS, "Cincinnati Reds"]) })[0];
    const MADE = "team_just_made" as Id<"teams">;
    const picked = addOtherTeam(group, defaultChoice(group), MADE);
    expect(picked).toEqual({ kind: "teams", refKeys: [teamIdKey(MADE)], extra: [MADE] });
    expect(answerForChoice(group, effectiveChoice(group, picked))).toEqual({ teamIds: [MADE] });
    const none = chooseKind(picked, "none");
    expect(none).toEqual({ kind: "none", extra: [MADE] });
    expect(extraTeamIds({ [group.key]: none })).toEqual([MADE]);
    // A pick of a team the line already offers selects that chip, adds nothing.
    expect(addOtherTeam(group, defaultChoice(group), REDS)).toEqual({
      kind: "teams",
      refKeys: [teamIdKey(REDS)],
    });
  });

  test("an Other-team pick from another sport never reaches the commit", () => {
    const group = multiGroup();
    const FOREIGN = "team_jets" as Id<"teams">;
    const choice = addOtherTeam(group, toggleTeam(group, defaultChoice(group), teamIdKey(REDS)), FOREIGN);
    expect(answerForChoice(group, choice, new Set([FOREIGN]))).toEqual({ teamIds: [REDS] });
  });

  test("per-card: one card in a grouped line takes its own answer; 'line' hands it back", () => {
    const cards = [card("1", ["Johnny Bench"]), card("2", ["Johnny Bench"]), card("3", ["Johnny Bench"])];
    const groups = build(cards, [], {
      "name:bench johnny": answered([REDS, "Cincinnati Reds"]),
    });
    const group = groups[0];
    const own = cardChoiceKey(group.key, 1);
    const choices = { [own]: { kind: "none" as const } };
    expect(hasCardOverride(group, choices, 1)).toBe(true);
    expect(hasCardOverride(group, choices, 0)).toBe(false);
    expect(teamAnswersByCard(groups, choices, 3)).toEqual([
      { teamIds: [REDS] },
      { teamNone: true },
      { teamIds: [REDS] },
    ]);
    const back = { [own]: { kind: "line" as const } };
    expect(hasCardOverride(group, back, 1)).toBe(false);
    expect(effectiveCardChoice(group, back, 1)).toEqual(defaultChoice(group));
    // The line's own pick still reaches the cards that follow it.
    expect(
      teamAnswersByCard(groups, { [group.key]: { kind: "later" }, [own]: { kind: "none" } }, 3),
    ).toEqual([undefined, { teamNone: true }, undefined]);
  });
});

/**
 * NEO-335 — who is on a card when the review rows cannot say: a re-sync of a
 * set whose names were all settled in an earlier save opens the teams step
 * with NO rows (the teams-only entry), so the stored data has to say it. The
 * E2E shape (checklist-one-marketplace-skips-match-dialog STEP 10): 25 #NNO
 * cards, one player created and two cards answered in the first save, every
 * other printed name skipped as "not a person".
 */
describe("stored people — re-synced playerless rows and the set's skip records", () => {
  const PRINTED = [
    "Jeff Jablonski",
    "Chris Potter",
    "Frank Anzalone",
    "Tim Christian",
    "Team Photo",
  ];
  const roanoke = () => PRINTED.map((name) => card("NNO", [name], undefined, name));

  test("with no rows and nothing stored, every printed name is a player line (the bug's shape)", () => {
    const groups = build(roanoke());
    expect(groups).toHaveLength(PRINTED.length);
    expect(groups.some((g) => g.key === NO_PLAYERS_GROUP_KEY)).toBe(false);
  });

  test("re-synced rows the save keeps playerless share ONE no-players line, numbers never the key", () => {
    const settled = new Set([0]);
    const people: StoredPeople = { playerless: new Set([1, 2, 3, 4]) };
    const groups = build(roanoke(), [], {}, 1995, { settled, people });
    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(NO_PLAYERS_GROUP_KEY);
    expect(groups[0].players).toEqual([]);
    expect(groups[0].cards.map((c) => c.index)).toEqual([1, 2, 3, 4]);
    // Nothing is known about a card nobody is on: never pre-filled.
    expect(groups[0].suggestion).toBeNull();
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
    // …and nobody is looked up for it.
    expect(evidenceRequests(roanoke(), [], settled, people)).toEqual([]);
  });

  test("a playerless position beats the printed name even when a review row creates that player", () => {
    // The save keeps the stored row's (empty) players unless the review
    // accepted the incoming ones — so the created player's career must not
    // pre-fill a card he will not be on.
    const rows = [
      row({
        kind: "player",
        name: "Chris Potter",
        decision: { action: "create" },
        enrichment: { careerTeams: [{ name: "Roanoke Express", fromYear: 1994, toYear: 1996 }] },
      }),
    ];
    const cards = [card("NNO", ["Chris Potter"]), card("NNO", ["Chris Potter"])];
    const people: StoredPeople = { playerless: new Set([0]) };
    const groups = build(cards, rows, {}, 1995, { people });
    expect(groups.map((g) => g.key)).toEqual([NO_PLAYERS_GROUP_KEY, "players:chris potter"]);
    expect(groups[0].cards.map((c) => c.index)).toEqual([0]);
    expect(groups[1].cards.map((c) => c.index)).toEqual([1]);
  });

  test("a name the set's skip records rule 'not a person' is nobody, matched however it is spelled", () => {
    const people = storedPeople(undefined, ["Chris Potter", "TEAM PHOTO"]);
    const cards = [
      card("NNO", ["chris  potter"]),
      card("NNO", ["Team Photo"]),
      card("NNO", ["Jeff Jablonski"]),
    ];
    const groups = build(cards, [], {}, undefined, { people });
    expect(groups.map((g) => g.cards.map((c) => c.index))).toEqual([[0, 1], [2]]);
    expect(groups[0].key).toBe(NO_PLAYERS_GROUP_KEY);
    expect(groups[1].players).toEqual(["Jeff Jablonski"]);
    // Only the real person is looked up.
    expect(evidenceRequests(cards, [], undefined, people)).toEqual([
      { key: "name:jablonski jeff", name: "Jeff Jablonski" },
    ]);
  });

  test("a skipped name beside a real one leaves the real one on the card", () => {
    const people = storedPeople(undefined, ["Checklist"]);
    const groups = build([card("1", ["Checklist", "Johnny Bench"])], [], {}, undefined, { people });
    expect(groups).toHaveLength(1);
    expect(groups[0].players).toEqual(["Johnny Bench"]);
  });

  test("a review row in THIS sitting outranks an old skip record for the same name", () => {
    // The operator un-skipped the name (or it came back as unknown): what they
    // decided now is the answer, not the earlier ruling.
    const rows = [
      row({
        kind: "player",
        name: "Chris Potter",
        decision: { action: "link", linkedPlayerId: BENCH },
      }),
    ];
    const people = storedPeople(undefined, ["Chris Potter"]);
    const cards = [card("NNO", ["Chris Potter"])];
    expect(evidenceRequests(cards, rows, undefined, people)).toEqual([
      { key: `id:${BENCH}`, playerId: BENCH },
    ]);
  });

  test("a created player's career is not resolved for a card the save keeps playerless", () => {
    const rows = [
      row({
        kind: "player",
        name: "Chris Potter",
        decision: { action: "create" },
        enrichment: { careerTeams: [{ name: "Roanoke Express", fromYear: 1994, toYear: 1996 }] },
      }),
    ];
    const cards = [card("NNO", ["Chris Potter"])];
    expect(teamNameRequests(cards, rows)).toEqual([
      { key: "express roanoke", name: "Roanoke Express" },
    ]);
    expect(teamNameRequests(cards, rows, undefined, { playerless: new Set([0]) })).toEqual([]);
  });

  test("stored people never change WHO is in the section — only how the lines group", () => {
    const cards = roanoke();
    const people: StoredPeople = { playerless: new Set([0, 1, 2, 3, 4]) };
    expect(teamlessCardIndexes(cards, [], new Set([0]))).toEqual([1, 2, 3, 4]);
    expect(
      build(cards, [], {}, undefined, { settled: new Set([0]), people }).flatMap((g) =>
        g.cards.map((c) => c.index),
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  test("storedPeople: nothing to say is undefined; names are normalized, blanks dropped", () => {
    expect(storedPeople()).toBeUndefined();
    expect(storedPeople([], [])).toBeUndefined();
    expect(storedPeople([], ["  "])).toBeUndefined();
    const people = storedPeople([2, 0], ["Chris Potter"]);
    expect([...(people?.playerless ?? [])]).toEqual([2, 0]);
    expect([...(people?.skippedPlayerNames ?? [])]).toEqual(["chris potter"]);
  });
});
