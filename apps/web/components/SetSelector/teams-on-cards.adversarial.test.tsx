/**
 * NEO-335 Phase 2 — adversarial pass over `teams-on-cards.ts`.
 *
 * Product invariant 8 is the target: a listing-named team that NB could not
 * resolve (and the operator has not ruled "not a team"), or a failed lookup,
 * holds back EVERY pre-fill — batch, stored, career, preference, multi-player
 * union — and a name ruled "not a team" holds back none. Then the caps and the
 * per-card override.
 *
 * `.test.tsx` because `.test.ts` is not collected under components/.
 */

import { describe, expect, test } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import {
  addOtherTeam,
  answerForChoice,
  buildTeamsGroups,
  cardChoiceKey,
  chooseKind,
  defaultChoice,
  effectiveCardChoice,
  effectiveChoice,
  evidenceRequests,
  hasCardOverride,
  MAX_CARD_TEAMS,
  teamAnswersByCard,
  teamIdKey,
  teamlessCardIndexes,
  teamNameRequests,
  toggleTeam,
  withTeamAnswer,
  type GroupChoice,
  type PreviewCardForTeams,
  type ServerPlayerEvidence,
  type ServerTeam,
  type TeamsGroup,
  type TeamsReviewRow,
} from "./teams-on-cards";

const REDS = "team_reds" as Id<"teams">;
const YANKEES = "team_yankees" as Id<"teams">;
const PHILLIES = "team_phillies" as Id<"teams">;
const teamN = (n: number) => `team_n${n}` as Id<"teams">;

function card(
  cardNumber: string,
  players: string[],
  teams?: string[],
  extra: Partial<PreviewCardForTeams> = {},
): PreviewCardForTeams {
  return { cardNumber, cardName: `Card ${cardNumber}`, players, ...(teams ? { teams } : {}), ...extra };
}

let rowCounter = 0;
function row(partial: Omit<TeamsReviewRow, "_id">): TeamsReviewRow {
  rowCounter += 1;
  return { _id: `adv_row_${rowCounter}`, ...partial };
}
const unruled = (name: string) => row({ kind: "team", name, decision: null });
const skipped = (name: string) => row({ kind: "team", name, decision: { action: "skip" } });

const st = (teamId: Id<"teams">, name: string, rank?: number): ServerTeam => ({
  teamId,
  name,
  ...(rank !== undefined ? { rank } : {}),
});
const answered = (...teams: ServerTeam[]): ServerPlayerEvidence => ({
  answer: { tier: "oneTeamInWindow", teams },
  candidates: [],
});
const unsure = (...teams: ServerTeam[]): ServerPlayerEvidence => ({ answer: null, candidates: teams });

function build(
  cards: PreviewCardForTeams[],
  rows: TeamsReviewRow[] = [],
  evidence: Record<string, ServerPlayerEvidence> = {},
  extra: {
    setYear?: number;
    teamNameEvidence?: Record<string, ServerTeam[]>;
    setLeagueId?: string | null;
    settled?: ReadonlySet<number>;
  } = {},
) {
  return buildTeamsGroups({
    cards,
    rows,
    serverEvidence: new Map(Object.entries(evidence)),
    setYear: extra.setYear,
    linkedTeamNameById: new Map(),
    currentYear: 2026,
    ...(extra.settled ? { settled: extra.settled } : {}),
    ...(extra.teamNameEvidence
      ? { teamNameEvidence: new Map(Object.entries(extra.teamNameEvidence)) }
      : {}),
    ...(extra.setLeagueId !== undefined ? { setLeagueId: extra.setLeagueId } : {}),
  });
}

const BENCH = "name:bench johnny";
const labels = (g: TeamsGroup) => g.refs.map((r) => r.label);

describe("invariant 8 — a lookup that failed blocks EVERY pre-fill", () => {
  const failed = (n: string, players: string[], teams?: string[]) =>
    card(n, players, teams, { teamLookup: "failed" });

  test("a sibling's resolving team (batch) is offered, not pre-filled", () => {
    const groups = build(
      [failed("1", ["Johnny Bench"]), card("2", ["Johnny Bench"], ["Reds"])],
      [],
      {},
    );
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual(["Reds"]);
    expect(teamAnswersByCard(groups, {}, 2)).toEqual([undefined, undefined]);
  });

  test("a created player's one-team career is offered, not pre-filled", () => {
    const rows = [
      row({
        kind: "player",
        name: "Rookie Guy",
        enrichment: { careerTeams: [{ name: "Reds", fromYear: 2025 }] },
        decision: { action: "create" },
      }),
    ];
    const groups = build([failed("1", ["Rookie Guy"])], rows, {}, { setYear: 2025 });
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual(["Reds"]);
  });

  test("a two-player union that would have pre-filled is held back as choices", () => {
    const cards = [failed("1", ["A Player", "B Player"])];
    const [a, b] = evidenceRequests(cards, []);
    const groups = build(cards, [], {
      [a.key]: answered(st(REDS, "Cincinnati Reds")),
      [b.key]: answered(st(YANKEES, "New York Yankees")),
    });
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual(["Cincinnati Reds", "New York Yankees"]);
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
  });

  test("a preferred-in-window answer is held back too (the rank breaks no tie here)", () => {
    const groups = build([failed("1", ["Johnny Bench"])], [], {
      [BENCH]: {
        answer: { tier: "preferredInWindow", teams: [st(REDS, "Cincinnati Reds", 0)] },
        candidates: [st(PHILLIES, "Philadelphia Phillies", 2)],
      },
    });
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual(["Cincinnati Reds", "Philadelphia Phillies"]);
  });

  test("a card with no players at all is held by it too (nothing to pre-fill, but the flag travels)", () => {
    const groups = build([failed("1", [])]);
    expect(groups[0].lookupFailed).toBe(true);
    expect(groups[0].suggestion).toBeNull();
  });

  test("failed beside answered for the same player: two lines, only the answered one pre-fills", () => {
    const groups = build(
      [
        failed("1", ["Johnny Bench"]),
        card("2", ["Johnny Bench"], undefined, { teamLookup: "answered" }),
        failed("3", ["Johnny Bench"]),
      ],
      [],
      { [BENCH]: answered(st(REDS, "Cincinnati Reds")) },
    );
    expect(groups).toHaveLength(2);
    expect(groups[0].cards.map((c) => c.index)).toEqual([0, 2]);
    expect(groups[1].suggestion).not.toBeNull();
  });

  test("a lookup that ANSWERED with nothing (no team printed) is no claim: the pre-fill stands", () => {
    const groups = build([card("1", ["Johnny Bench"], undefined, { teamLookup: "answered" })], [], {
      [BENCH]: answered(st(REDS, "Cincinnati Reds")),
    });
    expect(groups[0].lookupFailed).toBe(false);
    expect(groups[0].suggestion).toEqual([teamIdKey(REDS)]);
  });
});

describe("invariant 8 — the listing's name: spellings, mixes and skips", () => {
  test("the same unruled name in two spellings is ONE claim, on one line", () => {
    const rows = [unruled("Bulls"), unruled("BULLS")];
    const groups = build(
      [card("1", ["Johnny Bench"], ["Bulls"]), card("2", ["Johnny Bench"], ["  bulls "])],
      rows,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].cards.map((c) => c.index)).toEqual([0, 1]);
  });

  test("two different unruled names on two cards of one player are two lines, each held back", () => {
    const rows = [unruled("Bulls"), unruled("Mud Hens")];
    const groups = build(
      [card("1", ["Johnny Bench"], ["Bulls"]), card("2", ["Johnny Bench"], ["Mud Hens"])],
      rows,
      { [BENCH]: answered(st(REDS, "Cincinnati Reds")) },
    );
    expect(groups).toHaveLength(2);
    for (const g of groups) {
      expect(g.suggestion).toBeNull();
      expect(labels(g)).toEqual(["Cincinnati Reds"]);
    }
    expect(groups.map((g) => g.listedNames)).toEqual([["Bulls"], ["Mud Hens"]]);
  });

  test("an unruled name on a card with NO players is still shown and still blocks (nothing to pre-fill, claim kept)", () => {
    const groups = build([card("1", [], ["Bulls"])], [unruled("Bulls")]);
    expect(groups[0].listedNames).toEqual(["Bulls"]);
    expect(groups[0].suggestion).toBeNull();
  });

  test("a skipped name beside an ANSWERED lookup pre-fills as if nothing was printed", () => {
    const groups = build(
      [card("1", ["Johnny Bench"], ["Team Card"], { teamLookup: "answered" })],
      [skipped("Team Card")],
      { [BENCH]: answered(st(REDS, "Cincinnati Reds")) },
    );
    expect(groups[0].listedNames).toEqual([]);
    expect(groups[0].suggestion).toEqual([teamIdKey(REDS)]);
  });

  test("every printed name skipped, one of them spelled differently, still no claim", () => {
    const groups = build(
      [card("1", ["Johnny Bench"], ["Team Card", "TEAM  card!"])],
      [skipped("team card")],
      { [BENCH]: answered(st(REDS, "Cincinnati Reds")) },
    );
    expect(groups[0].listedNames).toEqual([]);
    expect(groups[0].suggestion).toEqual([teamIdKey(REDS)]);
  });

  test("a name that is only decided LATER (undecided -> skip) moves the line from held back to pre-filled", () => {
    const cards = [card("1", ["Johnny Bench"], ["Bulls"])];
    const evidence = { [BENCH]: answered(st(REDS, "Cincinnati Reds")) };
    const before = build(cards, [unruled("Bulls")], evidence);
    const after = build(cards, [skipped("Bulls")], evidence);
    expect(before[0].suggestion).toBeNull();
    expect(after[0].suggestion).toEqual([teamIdKey(REDS)]);
  });

  test("listed names that resolve to NB teams come first, ahead of the evidence, and are never pre-selected", () => {
    const groups = build(
      [card("1", ["Johnny Bench"], ["Bulls"])],
      [unruled("Bulls")],
      { [BENCH]: answered(st(REDS, "Cincinnati Reds")) },
      {
        teamNameEvidence: {
          bulls: [st(PHILLIES, "Philadelphia Bulls"), st(YANKEES, "New York Bulls")],
        },
      },
    );
    expect(labels(groups[0])).toEqual([
      "Philadelphia Bulls",
      "New York Bulls",
      "Cincinnati Reds",
    ]);
    expect(groups[0].suggestion).toBeNull();
    expect(teamAnswersByCard(groups, {}, 1)).toEqual([undefined]);
  });

  test("a listed name whose lookup returned NOTHING stays held back: not loading, no choices, still no pre-fill", () => {
    const groups = build(
      [card("1", ["Johnny Bench"], ["Bulls"])],
      [unruled("Bulls")],
      { [BENCH]: answered(st(REDS, "Cincinnati Reds")) },
      { teamNameEvidence: { bulls: [] } },
    );
    expect(groups[0].loading).toBe(false);
    expect(groups[0].suggestion).toBeNull();
    expect(labels(groups[0])).toEqual(["Cincinnati Reds"]);
  });

  test("the claim holds even when the evidence has not arrived: still loading, still nothing pre-selected", () => {
    const groups = build([card("1", ["Johnny Bench"], ["Bulls"])], [unruled("Bulls")]);
    expect(groups[0].loading).toBe(true);
    expect(groups[0].suggestion).toBeNull();
  });

  test("the section keeps a card whose only strings are unruled or skipped, and asks about the unruled one only", () => {
    const cards = [card("1", ["A"], ["Bulls", "Team Card"])];
    const rows = [unruled("Bulls"), skipped("Team Card")];
    expect(teamlessCardIndexes(cards, rows)).toEqual([0]);
    expect(teamNameRequests(cards, rows).map((r) => r.name)).toEqual(["Bulls"]);
  });
});

describe("MAX_CARD_TEAMS — exactly the cap, and one past it", () => {
  const twoPlayers = (a: ServerTeam[], b: ServerTeam[]) => {
    const cards = [card("1", ["A Player", "B Player"])];
    const [ra, rb] = evidenceRequests(cards, []);
    return build(cards, [], { [ra.key]: answered(...a), [rb.key]: answered(...b) });
  };

  test("a union of exactly MAX_CARD_TEAMS is pre-filled whole", () => {
    const all = Array.from({ length: MAX_CARD_TEAMS }, (_, i) => st(teamN(i), `Team ${i}`));
    const groups = twoPlayers(all.slice(0, 4), all.slice(4));
    expect(groups[0].suggestion).toHaveLength(MAX_CARD_TEAMS);
    expect(answerForChoice(groups[0], defaultChoice(groups[0]))?.teamIds).toHaveLength(MAX_CARD_TEAMS);
  });

  test("a union of MAX_CARD_TEAMS + 1 is never pre-filled, and every team is still a choice for the operator", () => {
    const all = Array.from({ length: MAX_CARD_TEAMS + 1 }, (_, i) => st(teamN(i), `Team ${i}`));
    const groups = twoPlayers(all.slice(0, 5), all.slice(5));
    expect(groups[0].suggestion).toBeNull();
    expect(groups[0].refs.length).toBeGreaterThan(0);
    expect(defaultChoice(groups[0])).toEqual({ kind: "later" });
  });

  test("two players answering the SAME team is a union of one, not two", () => {
    const groups = twoPlayers([st(REDS, "Cincinnati Reds")], [st(REDS, "Cincinnati Reds")]);
    expect(groups[0].suggestion).toEqual([teamIdKey(REDS)]);
    expect(groups[0].multi).toBe(true);
  });

  test("effectiveChoice never returns more than the cap even if the stored pick is longer", () => {
    const groups = twoPlayers([st(REDS, "Cincinnati Reds")], [st(YANKEES, "New York Yankees")]);
    const extra = Array.from({ length: MAX_CARD_TEAMS + 3 }, (_, i) => teamN(i));
    const choice: GroupChoice = {
      kind: "teams",
      refKeys: extra.map(teamIdKey),
      extra,
    };
    const effective = effectiveChoice(groups[0], choice);
    expect(effective.kind === "teams" && effective.refKeys).toHaveLength(MAX_CARD_TEAMS);
  });

  test("a pick repeating one team is one team", () => {
    const groups = twoPlayers([st(REDS, "Cincinnati Reds")], [st(YANKEES, "New York Yankees")]);
    const effective = effectiveChoice(groups[0], {
      kind: "teams",
      refKeys: [teamIdKey(REDS), teamIdKey(REDS)],
    });
    expect(effective).toEqual({ kind: "teams", refKeys: [teamIdKey(REDS)] });
    expect(answerForChoice(groups[0], effective)).toEqual({ teamIds: [REDS] });
  });

  test("the cap is on SELECTED teams: nine offered with Other team, eight picked", () => {
    const groups = twoPlayers([st(REDS, "Cincinnati Reds")], [st(YANKEES, "New York Yankees")]);
    let choice: GroupChoice = defaultChoice(groups[0]);
    for (let i = 0; i < MAX_CARD_TEAMS + 1; i++) choice = addOtherTeam(groups[0], choice, teamN(i));
    const answer = answerForChoice(groups[0], effectiveChoice(groups[0], choice));
    expect(answer?.teamIds).toHaveLength(MAX_CARD_TEAMS);
    // The one that did not fit is offered (extra), never written.
    expect(answer?.teamIds).not.toContain(teamN(MAX_CARD_TEAMS));
  });
});

describe("No team vs picks, and the per-card override", () => {
  const trio = () => {
    const cards = [card("1", ["Johnny Bench"]), card("2", ["Johnny Bench"]), card("3", ["Johnny Bench"])];
    return build(cards, [], { [BENCH]: answered(st(REDS, "Cincinnati Reds")) });
  };

  test("'No team' writes teamNone and never a team id, even over a pre-fill and an Other team pick", () => {
    const groups = trio();
    const picked = addOtherTeam(groups[0], defaultChoice(groups[0]), teamN(1));
    const none = chooseKind(picked, "none");
    expect(answerForChoice(groups[0], none)).toEqual({ teamNone: true });
    // and coming back restores the pick, extras intact
    expect(
      answerForChoice(groups[0], toggleTeam(groups[0], none, teamIdKey(REDS))),
    ).toEqual({ teamIds: [REDS] });
  });

  test("'Leave for later' on a card overrides the line's pre-fill: that card sends nothing", () => {
    const groups = trio();
    const own = cardChoiceKey(groups[0].key, 1);
    const choices = { [own]: { kind: "later" as const } };
    expect(teamAnswersByCard(groups, choices, 3)).toEqual([
      { teamIds: [REDS] },
      undefined,
      { teamIds: [REDS] },
    ]);
  });

  test("an override on card 1 never leaks to card 0 or 2, whatever the order they were set in", () => {
    const groups = trio();
    const k = (i: number) => cardChoiceKey(groups[0].key, i);
    const choices: Record<string, GroupChoice> = {
      [k(2)]: { kind: "none" },
      [k(0)]: { kind: "later" },
    };
    expect(teamAnswersByCard(groups, choices, 3)).toEqual([
      undefined,
      { teamIds: [REDS] },
      { teamNone: true },
    ]);
    expect(hasCardOverride(groups[0], choices, 1)).toBe(false);
  });

  test("a line choice changes the cards that have no override, and only them", () => {
    const groups = trio();
    const choices: Record<string, GroupChoice> = {
      [groups[0].key]: { kind: "none" },
      [cardChoiceKey(groups[0].key, 0)]: { kind: "teams", refKeys: [teamIdKey(REDS)] },
    };
    expect(teamAnswersByCard(groups, choices, 3)).toEqual([
      { teamIds: [REDS] },
      { teamNone: true },
      { teamNone: true },
    ]);
  });

  test("an override filed under another line's key does nothing", () => {
    const groups = trio();
    const choices = { [cardChoiceKey("players:somebody else", 1)]: { kind: "none" as const } };
    expect(effectiveCardChoice(groups[0], choices, 1)).toEqual(defaultChoice(groups[0]));
  });

  test("a held-back line takes a per-card pick, and a card that did not get one still sends nothing", () => {
    const rows = [unruled("Bulls")];
    const groups = build(
      [card("1", ["Johnny Bench"], ["Bulls"]), card("2", ["Johnny Bench"], ["Bulls"])],
      rows,
      { [BENCH]: unsure(st(REDS, "Cincinnati Reds")) },
    );
    const choices = {
      [cardChoiceKey(groups[0].key, 1)]: { kind: "teams" as const, refKeys: [teamIdKey(REDS)] },
    };
    expect(teamAnswersByCard(groups, choices, 2)).toEqual([undefined, { teamIds: [REDS] }]);
  });

  test("answers are positional: a stale position past the card count is dropped, a negative one cannot exist", () => {
    const groups = trio();
    expect(teamAnswersByCard(groups, {}, 2)).toEqual([{ teamIds: [REDS] }, { teamIds: [REDS] }]);
    expect(teamAnswersByCard(groups, {}, 0)).toEqual([]);
  });

  test("answerForChoice on a stale key (a chip the line no longer offers) writes nothing, not the key's text", () => {
    const groups = trio();
    expect(
      answerForChoice(groups[0], { kind: "teams", refKeys: ["id:team_gone"] }),
    ).toBeUndefined();
    expect(
      answerForChoice(groups[0], { kind: "teams", refKeys: ["name:made up"] }),
    ).toBeUndefined();
  });

  test("a blocked extra is dropped but the other picks on the card still go", () => {
    const groups = trio();
    const choice: GroupChoice = {
      kind: "teams",
      refKeys: [teamIdKey(REDS), teamIdKey(teamN(7))],
      extra: [teamN(7)],
    };
    expect(answerForChoice(groups[0], choice, new Set([teamN(7)]))).toEqual({ teamIds: [REDS] });
    // ...and when the blocked one was the only pick, the card is left for later rather than sent empty.
    expect(
      answerForChoice(groups[0], { kind: "teams", refKeys: [teamIdKey(teamN(7))], extra: [teamN(7)] }, new Set([teamN(7)])),
    ).toBeUndefined();
  });
});

describe("withTeamAnswer — what lands on the preview card", () => {
  const printed = card("1", ["A"], ["Skipped Name"]);

  test("a teamNone answer leaves the printed strings alone and adds no team", () => {
    const out = withTeamAnswer(printed, { teamNone: true });
    expect(out.teamNone).toBe(true);
    expect(out.teams).toEqual(["Skipped Name"]);
    expect(out.teamIds).toBeUndefined();
    expect(out.teamsAnswered).toBeUndefined();
  });

  test("ids and a staged string together: ids as ids, the string replaces the printed ones and is marked answered", () => {
    const out = withTeamAnswer(printed, { teamIds: [REDS], teams: ["Staged Team"] });
    expect(out.teamIds).toEqual([REDS]);
    expect(out.teams).toEqual(["Staged Team"]);
    expect(out.teamsAnswered).toBe(true);
    expect(out.teamNone).toBeUndefined();
  });

  test("an empty answer object is the same as no answer: the card comes back untouched", () => {
    const out = withTeamAnswer(printed, { teamIds: [], teams: [] });
    expect(out.teams).toEqual(["Skipped Name"]);
    expect(out.teamIds).toBeUndefined();
  });
});

describe("settled and skipped positions", () => {
  test("a settled position that also has a failed lookup is not in the section at all", () => {
    const groups = build(
      [card("1", ["Johnny Bench"], undefined, { teamLookup: "failed" })],
      [],
      {},
      { settled: new Set([0]) },
    );
    expect(groups).toEqual([]);
  });

  test("a settled sibling that prints a team is batch evidence for the line (it resolves, it is not a claim)", () => {
    const groups = build(
      [card("1", ["Johnny Bench"]), card("2", ["Johnny Bench"], ["Reds"])],
      [],
      {},
      { settled: new Set([1]) },
    );
    expect(groups[0].suggestion).not.toBeNull();
  });
});
