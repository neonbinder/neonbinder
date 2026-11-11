/**
 * NEO-490 — the operator's checklist links as pure functions: the question the
 * server is asked, and the answer folded back onto the cards.
 */

import { describe, expect, test } from "vitest";
import {
  applyChecklistAnswers,
  buildChecklistPairRequests,
  countChecklistTeams,
  type ChecklistLinkRow,
  type ChecklistPairAnswer,
} from "./checklist-match-apply";
import type { ChecklistConflict, TeamLookupOutcome } from "./checklist-conflict";

type Card = {
  key: string;
  cardNumber: string;
  players?: string[];
  teams?: string[];
  teamLookup?: TeamLookupOutcome;
  checklistConflict?: ChecklistConflict;
  rawTeamName?: string;
  platformData?: { bsc?: { ref: string } };
};

const keyOf = (c: Card) => c.key;
const card = (key: string, extra: Partial<Card> = {}): Card => ({
  key,
  cardNumber: `N-${key}`,
  ...extra,
});

describe("buildChecklistPairRequests", () => {
  const rows: ChecklistLinkRow[] = [
    { number: "1", players: ["Frank Thomas"], teams: ["Chicago White Sox"] },
    { number: "2", players: ["Jacob Wilson"], teams: [] },
  ];

  test("asks about each linked card in card order, with the card's current values beside the row", () => {
    const cards = [
      card("a", { players: ["Jacob Wilson"], teams: ["Athletics"] }),
      card("b"),
      card("c", { players: ["Frank Thomas"] }),
    ];
    const links = new Map([
      ["c", 0],
      ["a", 1],
    ]);

    const out = buildChecklistPairRequests(cards, links, rows, keyOf);

    expect(out).toEqual([
      {
        cardKey: "a",
        card: { cardNumber: "N-a", players: ["Jacob Wilson"], teams: ["Athletics"] },
        row: { number: "2", players: ["Jacob Wilson"], teams: [] },
      },
      {
        cardKey: "c",
        card: { cardNumber: "N-c", players: ["Frank Thomas"], teams: [] },
        row: { number: "1", players: ["Frank Thomas"], teams: ["Chicago White Sox"] },
      },
    ]);
  });

  test("a link whose card is not being saved is left out", () => {
    const out = buildChecklistPairRequests(
      [card("a")],
      new Map([
        ["a", 0],
        ["discarded", 1],
      ]),
      rows,
      keyOf,
    );
    expect(out.map((r) => r.cardKey)).toEqual(["a"]);
  });

  test("a link to a row index that does not exist is left out", () => {
    expect(
      buildChecklistPairRequests([card("a")], new Map([["a", 9]]), rows, keyOf),
    ).toEqual([]);
  });

  test("no links, no questions", () => {
    expect(buildChecklistPairRequests([card("a")], new Map(), rows, keyOf)).toEqual([]);
  });

  test("blank names are trimmed away on both sides", () => {
    const [req] = buildChecklistPairRequests(
      [card("a", { players: [" Jacob Wilson ", "  "], teams: [""] })],
      new Map([["a", 0]]),
      [{ number: "1", players: ["  Frank Thomas", ""], teams: [" "] }],
      keyOf,
    );
    expect(req.card.players).toEqual(["Jacob Wilson"]);
    expect(req.card.teams).toEqual([]);
    expect(req.row.players).toEqual(["Frank Thomas"]);
    expect(req.row.teams).toEqual([]);
  });

  test("noNumber travels only when the row is flagged", () => {
    const flagged = buildChecklistPairRequests(
      [card("a")],
      new Map([["a", 0]]),
      [{ number: "NNO", players: ["X"], teams: [], noNumber: true }],
      keyOf,
    );
    const plain = buildChecklistPairRequests(
      [card("a")],
      new Map([["a", 0]]),
      [{ number: "1", players: ["X"], teams: [] }],
      keyOf,
    );
    expect(flagged[0].row.noNumber).toBe(true);
    expect(plain[0].row).not.toHaveProperty("noNumber");
  });

  test("the card's own number is sent, never the row's", () => {
    const [req] = buildChecklistPairRequests(
      [card("a", { cardNumber: "SIG-FT" })],
      new Map([["a", 0]]),
      rows,
      keyOf,
    );
    expect(req.card.cardNumber).toBe("SIG-FT");
    expect(req.row.number).toBe("1");
  });
});

describe("applyChecklistAnswers", () => {
  const sox = ["Chicago White Sox"];

  test("a settled team replaces the card's teams, marks the lookup, and drops BSC's raw hint", () => {
    const original = card("a", { teams: ["Cubs"], rawTeamName: "Chi Sox", teamLookup: "failed" });
    const [out] = applyChecklistAnswers(
      [original],
      [{ cardKey: "a", teams: sox, teamLookup: "checklist" }],
      keyOf,
    );
    expect(out.teams).toEqual(sox);
    expect(out.teamLookup).toBe("checklist");
    expect(out).not.toHaveProperty("rawTeamName");
  });

  test("players fill a card that has none, and never overwrite one that has some", () => {
    const [empty, has] = applyChecklistAnswers(
      [card("a"), card("b", { players: ["Existing Name"] })],
      [
        { cardKey: "a", fillPlayers: ["Frank Thomas"] },
        { cardKey: "b", fillPlayers: ["Frank Thomas"] },
      ],
      keyOf,
    );
    expect(empty.players).toEqual(["Frank Thomas"]);
    expect(has.players).toEqual(["Existing Name"]);
  });

  test("a disagreement rides on the card; the card's own teams stay even if the answer carries teams", () => {
    const conflict: ChecklistConflict = {
      teams: { marketplace: ["Cubs"], checklist: sox },
    };
    const [out] = applyChecklistAnswers(
      [card("a", { teams: ["Cubs"] })],
      [{ cardKey: "a", teams: sox, teamLookup: "checklist", checklistConflict: conflict }],
      keyOf,
    );
    expect(out.checklistConflict).toEqual(conflict);
    expect(out.teams).toEqual(["Cubs"]);
    expect(out.teamLookup).toBeUndefined();
  });

  test("a players-only disagreement still lets a settled team through", () => {
    const conflict: ChecklistConflict = {
      players: { marketplace: ["A"], checklist: ["B"] },
    };
    const [out] = applyChecklistAnswers(
      [card("a", { players: ["A"] })],
      [{ cardKey: "a", teams: sox, teamLookup: "checklist", checklistConflict: conflict }],
      keyOf,
    );
    expect(out.checklistConflict).toEqual(conflict);
    expect(out.teams).toEqual(sox);
    expect(out.players).toEqual(["A"]);
  });

  test("teams without the checklist lookup mark are not applied, nor are empty teams", () => {
    const [noMark, emptyTeams] = applyChecklistAnswers(
      [card("a", { teams: ["Cubs"] }), card("b", { teams: ["Cubs"] })],
      [
        { cardKey: "a", teams: sox },
        { cardKey: "b", teams: [" "], teamLookup: "checklist" },
      ],
      keyOf,
    );
    expect(noMark.teams).toEqual(["Cubs"]);
    expect(emptyTeams.teams).toEqual(["Cubs"]);
    expect(emptyTeams.teamLookup).toBeUndefined();
  });

  test("a row naming no team makes no claim: an answer with nothing in it changes nothing", () => {
    const original = card("a", { teams: ["Cubs"], players: ["A"] });
    const [out] = applyChecklistAnswers([original], [{ cardKey: "a" }], keyOf);
    expect(out).toEqual(original);
  });

  test("same order and length; an unanswered card is returned by reference", () => {
    const a = card("a");
    const b = card("b");
    const c = card("c");
    const out = applyChecklistAnswers(
      [a, b, c],
      [{ cardKey: "b", teams: sox, teamLookup: "checklist" }],
      keyOf,
    );
    expect(out.map((x) => x.key)).toEqual(["a", "b", "c"]);
    expect(out[0]).toBe(a);
    expect(out[2]).toBe(c);
    expect(out[1]).not.toBe(b);
  });

  test("no answers returns a copy of the same cards", () => {
    const cards = [card("a")];
    const out = applyChecklistAnswers(cards, [], keyOf);
    expect(out).toEqual(cards);
    expect(out).not.toBe(cards);
    expect(out[0]).toBe(cards[0]);
  });

  test("an answer for a card that is not here is ignored", () => {
    const cards = [card("a")];
    const out = applyChecklistAnswers(
      cards,
      [{ cardKey: "zzz", teams: sox, teamLookup: "checklist" }],
      keyOf,
    );
    expect(out).toEqual(cards);
  });

  test("the input cards are not mutated, and the number and platformData never change", () => {
    const original = card("a", {
      cardNumber: "SIG-FT",
      teams: ["Cubs"],
      rawTeamName: "Chi",
      platformData: { bsc: { ref: "bsc-1" } },
    });
    const snapshot = JSON.parse(JSON.stringify(original));
    const answer: ChecklistPairAnswer = {
      cardKey: "a",
      teams: sox,
      teamLookup: "checklist",
      fillPlayers: ["Frank Thomas"],
    };
    const [out] = applyChecklistAnswers([original], [answer], keyOf);
    expect(original).toEqual(snapshot);
    expect(out.cardNumber).toBe("SIG-FT");
    expect(out.platformData).toEqual({ bsc: { ref: "bsc-1" } });
  });

  test("the last answer for a key wins", () => {
    const [out] = applyChecklistAnswers(
      [card("a")],
      [
        { cardKey: "a", teams: ["First"], teamLookup: "checklist" },
        { cardKey: "a", teams: ["Second"], teamLookup: "checklist" },
      ],
      keyOf,
    );
    expect(out.teams).toEqual(["Second"]);
  });
});

describe("countChecklistTeams", () => {
  test("counts only the cards whose team came from the checklist", () => {
    expect(
      countChecklistTeams([
        { teamLookup: "checklist" },
        { teamLookup: "failed" },
        {},
        { teamLookup: "checklist" },
      ]),
    ).toBe(2);
  });

  test("an empty list counts zero", () => {
    expect(countChecklistTeams([])).toBe(0);
  });
});
