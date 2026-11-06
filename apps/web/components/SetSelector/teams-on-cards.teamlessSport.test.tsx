/**
 * NEO-426 — a card whose every player's HOME sport is flagged "no teams" is
 * auto "No team on this card": it leaves the Teams step (`teamlessCardIndexes`
 * drops it) and is reported by `autoNoTeamIndexes` instead. The flag is a
 * default, never a block, and a data claim holds the default back.
 *
 * The server's half of the same rule is pinned in
 * convex/commitCardChecklist.teamAnswers.test.ts; the two must agree.
 *
 * `.test.tsx` because `.test.ts` is not collected under components/ (see
 * vitest.include.mjs).
 */

import { describe, expect, test } from "vitest";
import {
  autoNoTeamIndexes,
  evidenceRequests,
  storedPeople,
  teamlessCardIndexes,
  type PreviewCardForTeams,
  type TeamlessFacts,
  type TeamsReviewRow,
} from "./teams-on-cards";

const FLAGGED = "sport_flagged";
const BASEBALL = "sport_baseball";

let rowCounter = 0;
function row(partial: Omit<TeamsReviewRow, "_id">): TeamsReviewRow {
  rowCounter += 1;
  return { _id: `tl_row_${rowCounter}`, ...partial };
}

function card(
  cardNumber: string,
  players: string[],
  extra: Partial<PreviewCardForTeams> = {},
): PreviewCardForTeams {
  return { cardNumber, cardName: `Card ${cardNumber}`, players, ...extra };
}

/** Created in the flagged sport / in baseball. */
const createdIn = (name: string, sportId?: string) =>
  row({ kind: "player", name, ...(sportId ? { sportId } : {}), decision: { action: "create" } });
const linked = (name: string, linkedPlayerId?: string) =>
  row({ kind: "player", name, decision: { action: "link", ...(linkedPlayerId ? { linkedPlayerId } : {}) } });

function people(facts: TeamlessFacts, playerless?: number[]) {
  return storedPeople(playerless, undefined, undefined, facts);
}
const FLAGGED_ONLY: TeamlessFacts = { teamlessSportIds: [FLAGGED] };

/** The two lists for one setup. */
function lists(
  cards: PreviewCardForTeams[],
  rows: TeamsReviewRow[],
  p: ReturnType<typeof storedPeople>,
  settled?: ReadonlySet<number>,
) {
  return {
    asked: teamlessCardIndexes(cards, rows, settled, p),
    auto: autoNoTeamIndexes(cards, rows, settled, p),
  };
}

describe("autoNoTeamIndexes — whose home sport is teamless", () => {
  test("a player CREATED in a flagged sport is auto, not asked", () => {
    const rows = [createdIn("Pika Chu", FLAGGED)];
    expect(lists([card("1", ["Pika Chu"])], rows, people(FLAGGED_ONLY))).toEqual({
      asked: [],
      auto: [0],
    });
  });

  test("a player created in another sport is asked about, as before", () => {
    const rows = [createdIn("Johnny Bench", BASEBALL)];
    expect(lists([card("1", ["Johnny Bench"])], rows, people(FLAGGED_ONLY))).toEqual({
      asked: [0],
      auto: [],
    });
  });

  test("a created player with no sport on his row is not teamless", () => {
    const rows = [createdIn("Johnny Bench")];
    expect(lists([card("1", ["Johnny Bench"])], rows, people(FLAGGED_ONLY))).toEqual({
      asked: [0],
      auto: [],
    });
  });

  test("a LINKED player is teamless by his stored home sport", () => {
    const rows = [linked("Pika Chu", "pl_pika")];
    const p = people({
      teamlessSportIds: [FLAGGED],
      linkedPlayerSportIds: new Map([["pl_pika", FLAGGED]]),
    });
    expect(lists([card("1", ["Pika Chu"])], rows, p)).toEqual({ asked: [], auto: [0] });
  });

  test("a linked player whose home sport has teams, or is not loaded yet, is asked about", () => {
    const rows = [linked("Pika Chu", "pl_pika")];
    const hasTeams = people({
      teamlessSportIds: [FLAGGED],
      linkedPlayerSportIds: new Map([["pl_pika", BASEBALL]]),
    });
    expect(lists([card("1", ["Pika Chu"])], rows, hasTeams)).toEqual({ asked: [0], auto: [] });
    // Player docs not read yet: the map is empty, so he is unknown = not teamless.
    expect(lists([card("1", ["Pika Chu"])], rows, people(FLAGGED_ONLY))).toEqual({
      asked: [0],
      auto: [],
    });
  });

  test("a name the fetch resolved to a flagged-sport player is auto, matched on the normalized name", () => {
    const p = people({ teamlessPlayerNames: ["  Pika   CHU "] });
    expect(lists([card("1", ["pika chu"])], [], p)).toEqual({ asked: [], auto: [0] });
  });

  test("a resolved name the fetch did not list is asked about", () => {
    const p = people({ teamlessPlayerNames: ["Pika Chu"] });
    expect(lists([card("1", ["Johnny Bench"])], [], p)).toEqual({ asked: [0], auto: [] });
  });

  test("created, linked and name-resolved players mix on one card and all count", () => {
    const rows = [createdIn("Pika Chu", FLAGGED), linked("Char Zard", "pl_char")];
    const p = people({
      teamlessSportIds: [FLAGGED],
      linkedPlayerSportIds: new Map([["pl_char", FLAGGED]]),
      teamlessPlayerNames: ["Blast Oise"],
    });
    expect(lists([card("1", ["Pika Chu", "Char Zard", "Blast Oise"])], rows, p)).toEqual({
      asked: [],
      auto: [0],
    });
  });
});

describe("autoNoTeamIndexes — what keeps a card with the operator (invariant 8)", () => {
  const rows = [createdIn("Pika Chu", FLAGGED)];
  const p = () => people(FLAGGED_ONLY);

  test("a mixed card (one person whose sport has teams) is asked about", () => {
    const mixed = [...rows, createdIn("Johnny Bench", BASEBALL)];
    expect(lists([card("1", ["Pika Chu", "Johnny Bench"])], mixed, p())).toEqual({
      asked: [0],
      auto: [],
    });
  });

  test("a mixed card with one unknown (no row, not listed) person is asked about", () => {
    expect(lists([card("1", ["Pika Chu", "Someone Else"])], rows, p())).toEqual({
      asked: [0],
      auto: [],
    });
  });

  test("a card with nobody on it is asked about: nothing says what sport it is", () => {
    expect(lists([card("1", [])], rows, p())).toEqual({ asked: [0], auto: [] });
  });

  test("a stored playerless card is asked about even if its printed names are teamless", () => {
    const names = people({ teamlessPlayerNames: ["Pika Chu"] }, [0]);
    expect(lists([card("1", ["Pika Chu"])], [], names)).toEqual({ asked: [0], auto: [] });
  });

  test("a listing that names a team the card carries no string for (rawTeamName) holds it back", () => {
    expect(lists([card("1", ["Pika Chu"], { rawTeamName: "Pallet Town Pikas" })], rows, p())).toEqual({
      asked: [0],
      auto: [],
    });
  });

  test("a rawTeamName the operator ruled 'not a team' no longer holds it back", () => {
    const withSkip = [
      ...rows,
      row({ kind: "team", name: "Pallet Town Pikas", decision: { action: "skip" } }),
    ];
    expect(
      lists([card("1", ["Pika Chu"], { rawTeamName: "Pallet Town Pikas" })], withSkip, p()),
    ).toEqual({ asked: [], auto: [0] });
  });

  test("a rawTeamName skipped by an earlier save's record no longer holds it back", () => {
    const stored = storedPeople(undefined, undefined, ["Pallet Town Pikas"], FLAGGED_ONLY);
    expect(
      lists([card("1", ["Pika Chu"], { rawTeamName: "Pallet Town Pikas" })], rows, stored),
    ).toEqual({ asked: [], auto: [0] });
  });

  test("a printed team string ruled 'not a team' is no claim; the card is auto", () => {
    const withSkip = [
      ...rows,
      row({ kind: "team", name: "Checklist", decision: { action: "skip" } }),
    ];
    expect(lists([card("1", ["Pika Chu"], { teams: ["Checklist"] })], withSkip, p())).toEqual({
      asked: [],
      auto: [0],
    });
  });

  test("a failed team lookup holds it back: a missing answer goes to a person", () => {
    expect(lists([card("1", ["Pika Chu"], { teamLookup: "failed" })], rows, p())).toEqual({
      asked: [0],
      auto: [],
    });
  });

  test("an answered team lookup does not", () => {
    expect(lists([card("1", ["Pika Chu"], { teamLookup: "answered" })], rows, p())).toEqual({
      asked: [],
      auto: [0],
    });
  });

  test("a card with a BSC ref is auto only once its lookup ANSWERED: undefined and failed are asked about", () => {
    const bsc = { platformData: { bsc: { ref: "B1" } } };
    expect(lists([card("1", ["Pika Chu"], { ...bsc, teamLookup: "answered" })], rows, p())).toEqual({
      asked: [],
      auto: [0],
    });
    expect(lists([card("1", ["Pika Chu"], bsc)], rows, p())).toEqual({ asked: [0], auto: [] });
    expect(lists([card("1", ["Pika Chu"], { ...bsc, teamLookup: "failed" })], rows, p())).toEqual({
      asked: [0],
      auto: [],
    });
  });

  test("a card with no BSC ref has no lookup to wait for: undefined is auto", () => {
    const sl = { platformData: { sportlots: { ref: "S1" } } } as Partial<PreviewCardForTeams>;
    expect(lists([card("1", ["Pika Chu"], sl)], rows, p())).toEqual({ asked: [], auto: [0] });
    expect(lists([card("1", ["Pika Chu"])], rows, p())).toEqual({ asked: [], auto: [0] });
  });

  test("a player row with no decision yet is an unaccounted person: asked about", () => {
    const undecided = [row({ kind: "player", name: "Pika Chu", sportId: FLAGGED })];
    expect(lists([card("1", ["Pika Chu"])], undecided, p())).toEqual({ asked: [0], auto: [] });
  });

  test("a link with no player id is malformed, so asked about", () => {
    const bad = [linked("Pika Chu")];
    const facts = people({
      teamlessSportIds: [FLAGGED],
      linkedPlayerSportIds: new Map([["pl_pika", FLAGGED]]),
    });
    expect(lists([card("1", ["Pika Chu"])], bad, facts)).toEqual({ asked: [0], auto: [] });
  });

  test("a name ruled 'not a person' is nobody; the remaining teamless player decides", () => {
    const withSkip = [...rows, row({ kind: "player", name: "Checklist", decision: { action: "skip" } })];
    expect(lists([card("1", ["Pika Chu", "Checklist"])], withSkip, p())).toEqual({
      asked: [],
      auto: [0],
    });
  });

  test("a card whose only person was ruled 'not a person' has nobody and is asked about", () => {
    const onlySkip = [row({ kind: "player", name: "Checklist", decision: { action: "skip" } })];
    expect(lists([card("1", ["Checklist"])], onlySkip, p())).toEqual({ asked: [0], auto: [] });
  });

  test("flagged sports not loaded: nothing is auto, every card is asked about", () => {
    expect(lists([card("1", ["Pika Chu"])], rows, people({ teamlessSportIds: [] }))).toEqual({
      asked: [0],
      auto: [],
    });
    expect(lists([card("1", ["Pika Chu"])], rows, undefined)).toEqual({ asked: [0], auto: [] });
  });

  test("a card that already carries a resolved team is in neither list", () => {
    expect(lists([card("1", ["Pika Chu"], { teams: ["Pallet Town Pikas"] })], rows, p())).toEqual({
      asked: [],
      auto: [],
    });
  });
});

describe("autoNoTeamIndexes — settled, positional, evidence", () => {
  const rows = [createdIn("Pika Chu", FLAGGED), createdIn("Johnny Bench", BASEBALL)];

  test("a settled position is in neither list", () => {
    const cards = [card("1", ["Pika Chu"]), card("2", ["Johnny Bench"])];
    expect(lists(cards, rows, people(FLAGGED_ONLY), new Set([0, 1]))).toEqual({
      asked: [],
      auto: [],
    });
  });

  test("settling the asked card leaves the auto card alone, and the reverse", () => {
    const cards = [card("1", ["Pika Chu"]), card("2", ["Johnny Bench"])];
    expect(lists(cards, rows, people(FLAGGED_ONLY), new Set([1]))).toEqual({ asked: [], auto: [0] });
    expect(lists(cards, rows, people(FLAGGED_ONLY), new Set([0]))).toEqual({ asked: [1], auto: [] });
  });

  test("two cards with the same number are told apart by position", () => {
    const cards = [card("7", ["Pika Chu"]), card("7", ["Johnny Bench"])];
    expect(lists(cards, rows, people(FLAGGED_ONLY))).toEqual({ asked: [1], auto: [0] });
  });

  test("the two lists never overlap and together cover every would-be-teamless card", () => {
    const cards = [
      card("1", ["Pika Chu"]),
      card("2", ["Johnny Bench"]),
      card("3", []),
      card("4", ["Pika Chu"], { teamLookup: "failed" }),
      card("5", ["Pika Chu"], { teams: ["Resolved Team"] }),
    ];
    const { asked, auto } = lists(cards, rows, people(FLAGGED_ONLY));
    expect(auto).toEqual([0]);
    expect(asked).toEqual([1, 2, 3]);
    expect(asked.filter((i) => auto.includes(i))).toEqual([]);
  });

  test("evidence requests skip an auto card's players but still cover the asked ones", () => {
    const names = people({ teamlessPlayerNames: ["Pika Chu"] });
    const cards = [card("1", ["Pika Chu"]), card("2", ["Johnny Bench"])];
    expect(evidenceRequests(cards, [], undefined, names).map((r) => r.name)).toEqual(["Johnny Bench"]);
  });

  test("a mixed card still requests evidence for its teamless player: the operator is picking for the card", () => {
    const names = people({ teamlessPlayerNames: ["Pika Chu"] });
    const cards = [card("1", ["Pika Chu", "Johnny Bench"])];
    expect(evidenceRequests(cards, [], undefined, names).map((r) => r.name)).toEqual([
      "Pika Chu",
      "Johnny Bench",
    ]);
  });
});

describe("storedPeople — the teamless facts", () => {
  test("no facts at all still yields undefined", () => {
    expect(storedPeople(undefined, undefined, undefined, { teamlessSportIds: [] })).toBeUndefined();
    expect(storedPeople(undefined, undefined, undefined, {})).toBeUndefined();
  });

  test("a linked-sport map without a flagged sport is dropped: no linked player can be teamless", () => {
    const p = storedPeople(undefined, undefined, undefined, {
      teamlessPlayerNames: ["Pika Chu"],
      linkedPlayerSportIds: new Map([["pl", FLAGGED]]),
    });
    expect(p?.linkedPlayerSportIds).toBeUndefined();
    expect(p?.teamlessPlayerNames?.size).toBe(1);
  });
});
