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
  answerForChoice,
  buildTeamsGroups,
  defaultChoice,
  effectiveChoice,
  evidenceRequests,
  optionLabel,
  sameTeamAnswers,
  teamAnswersByCard,
  teamlessCardIndexes,
  withTeamAnswer,
  type PreviewCardForTeams,
  type ServerPlayerEvidence,
  type TeamsReviewRow,
} from "./teams-on-cards";

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
) {
  return buildTeamsGroups({
    cards,
    rows,
    serverEvidence: new Map(Object.entries(evidence)),
    setYear,
    linkedTeamNameById: new Map([[REDS, "Cincinnati Reds"]]),
    currentYear: 2026,
  });
}

const answered = (...teams: Array<[Id<"teams">, string]>): ServerPlayerEvidence => ({
  answer: { tier: "oneTeamCareer", teams: teams.map(([id, n]) => serverTeam(id, n)) },
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

  test("a card with nobody on it gets its own line", () => {
    const groups = build([card("1", []), card("2", [])]);
    expect(groups.map((g) => g.cards.length)).toEqual([1, 1]);
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
    expect(groups[0].suggestion?.refs).toEqual([
      { key: "name:reds", label: "Reds", name: "Reds" },
    ]);
    expect(defaultChoice(groups[0])).toEqual({ kind: "team", optionKey: groups[0].suggestion!.key });
  });

  test("a tie between siblings stays unselected — never the first one", () => {
    const groups = build([
      card("1", ["Johnny Bench"]),
      card("2", ["Johnny Bench"], ["Reds"]),
      card("3", ["Johnny Bench"], ["Phillies"]),
    ]);
    expect(groups[0].suggestion).toBeNull();
    expect(groups[0].options.map(optionLabel)).toEqual(["Reds", "Phillies"]);
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
    expect(groups[0].suggestion?.refs[0].label).toBe("Cincinnati Reds");
    expect(answerForChoice(groups[0], defaultChoice(groups[0]))).toEqual({ teams: ["Reds"] });
  });

  test("batch outranks the server", () => {
    const groups = build(
      [card("1", ["Johnny Bench"]), card("2", ["Johnny Bench"], ["Reds"])],
      [],
      { "name:johnny bench": answered([PHILLIES, "Philadelphia Phillies"]) },
    );
    expect(optionLabel(groups[0].suggestion!)).toBe("Reds");
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
    expect(groups[0].options).toEqual([]);
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
  });

  test("several server candidates stay unselected", () => {
    const cards = [card("1", ["Johnny Bench"])];
    const [request] = evidenceRequests(cards, []);
    const groups = build(cards, [], {
      [request.key]: unsure([REDS, "Cincinnati Reds"], [YANKEES, "New York Yankees"]),
    });
    expect(groups[0].suggestion).toBeNull();
    expect(groups[0].options.map(optionLabel)).toEqual(["Cincinnati Reds", "New York Yankees"]);
  });

  test("multi-player: every player answering → the union, pre-filled", () => {
    const cards = [card("1", ["A", "B"])];
    const [a, b] = evidenceRequests(cards, []);
    const groups = build(cards, [], {
      [a.key]: answered([REDS, "Cincinnati Reds"]),
      [b.key]: answered([YANKEES, "New York Yankees"]),
    });
    expect(optionLabel(groups[0].suggestion!)).toBe("Cincinnati Reds + New York Yankees");
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
    expect(groups[0].options.map(optionLabel)).toEqual([
      "Cincinnati Reds",
      "New York Yankees",
      "Philadelphia Phillies",
    ]);
  });

  test("a player created in this wizard answers from their own career", () => {
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
    const groups = build(cards, rows);
    expect(groups[0].suggestion?.refs[0]).toMatchObject({
      label: "Cincinnati Reds",
      name: "Reds",
      colors: { primary: "#C6011F" },
    });
  });

  test("a created player's unchecked career team is not evidence; one stint in the year is", () => {
    const rows = [
      row({
        kind: "player",
        name: "Traded Guy",
        enrichment: {
          careerTeams: [
            { name: "Reds", fromYear: 2018, toYear: 2020 },
            { name: "Phillies", fromYear: 2021, toYear: 2022 },
            { name: "Yankees", fromYear: 2023 },
          ],
        },
        decision: { action: "create", excludedCareerTeamNames: ["Yankees"] },
      }),
    ];
    const groups = build([card("1", ["Traded Guy"])], rows, {}, 2021);
    expect(optionLabel(groups[0].suggestion!)).toBe("Phillies");
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
    expect(effectiveChoice(groups[0], { kind: "team", optionKey: "gone" })).toEqual(
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
    });
    expect(withTeamAnswer(original, { teamNone: true })).toMatchObject({
      teams: ["Team Card"],
      teamNone: true,
    });
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
    expect(groups[0].options.map(optionLabel)).toEqual(["Reds", "Yankees"]);
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
  });

  test("two siblings printing the SAME team in a different spelling are one answer, not a tie", () => {
    const groups = build([
      card("1", ["Johnny Bench"]),
      card("2", ["Johnny Bench"], ["Reds"]),
      card("3", ["Johnny Bench"], ["  reds "]),
    ]);
    expect(groups[0].suggestion).not.toBeNull();
    expect(optionLabel(groups[0].suggestion!)).toBe("Reds");
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
    expect(groups[0].options).toHaveLength(6);
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

    const arrived = build(cards, rows, {
      "name:bench johnny": answered([YANKEES, "New York Yankees"]),
    });
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
    expect(groups[0].options).toEqual([]);
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
