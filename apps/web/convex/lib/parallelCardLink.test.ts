/**
 * NEO-312 — `linkCardsToSide`: which of the PARALLEL's fetched cards is each
 * of the INSERT's NB cards, on one marketplace side.
 *
 * Pure function, no database — plain unit tests over small fixtures, in the
 * style of `bscFacets.test.ts` / `marketplaceResolvability.test.ts`.
 */

import { describe, expect, test } from "vitest";
import {
  cardKey,
  linkCardsToSide,
  type FetchedParallelCard,
  type LinkableNbCard,
} from "./parallelCardLink";

/** An NB card, with sensible defaults so a test states only what it means. */
function nb(opts: Partial<LinkableNbCard> & { id: string }): LinkableNbCard {
  return {
    cardNumber: "1",
    cardName: "Some Player",
    namesOnCard: ["Some Player"],
    isTeamCard: false,
    isVariation: false,
    ...opts,
  };
}

/** A fetched parallel card, with sensible defaults. */
function fetched(opts: Partial<FetchedParallelCard> & { ref: string }): FetchedParallelCard {
  return {
    cardNumber: "1",
    cardName: "Some Player",
    players: ["Some Player"],
    ...opts,
  };
}

describe("linkCardsToSide — the number key", () => {
  test("an exact number + name match links", () => {
    const nbCards = [nb({ id: "n1", cardNumber: "10", cardName: "Ken Griffey" })];
    const parallelCards = [fetched({ ref: "p1", cardNumber: "10", cardName: "Ken Griffey" })];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({ kind: "linked", card: parallelCards[0], via: "key" });
    expect(result.linked).toBe(1);
    expect(result.ambiguous).toBe(0);
    expect(result.none).toBe(0);
  });

  test("a prefix on one side only still matches once stripped", () => {
    // The insert's chain carries `RC-`, the parallel's fetch does not.
    const nbCards = [nb({ id: "n1", cardNumber: "RC-10", cardName: "Ken Griffey" })];
    const parallelCards = [fetched({ ref: "p1", cardNumber: "10", cardName: "Ken Griffey" })];
    const result = linkCardsToSide(nbCards, parallelCards, { nb: "RC-" });
    expect(result.outcomes.get("n1")?.kind).toBe("linked");
  });

  test("prefixes stripped on both sides independently", () => {
    const nbCards = [nb({ id: "n1", cardNumber: "RC-10", cardName: "Ken Griffey" })];
    const parallelCards = [fetched({ ref: "p1", cardNumber: "GOLD-10", cardName: "Ken Griffey" })];
    const result = linkCardsToSide(nbCards, parallelCards, { nb: "RC-", fetched: "GOLD-" });
    expect(result.outcomes.get("n1")?.kind).toBe("linked");
  });

  test("a bare number never matches a stripped one when neither side declares a prefix", () => {
    const nbCards = [nb({ id: "n1", cardNumber: "RC-10", cardName: "Ken Griffey" })];
    const parallelCards = [fetched({ ref: "p1", cardNumber: "10", cardName: "Ken Griffey" })];
    const result = linkCardsToSide(nbCards, parallelCards); // no prefixes given
    expect(result.outcomes.get("n1")).toEqual({ kind: "none" });
  });

  test("a variation's stem matches the other side's bare number — variations only", () => {
    const nbCards = [
      nb({
        id: "n1",
        cardNumber: "11b",
        cardName: "Ken Griffey",
        isVariation: true,
        cardVariation: "Action",
      }),
    ];
    const parallelCards = [
      fetched({
        ref: "p1",
        cardNumber: "11",
        cardName: "Ken Griffey",
        isVariation: true,
        cardVariation: "Action",
      }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")?.kind).toBe("linked");
  });

  test("stem matching never applies to a non-variation card", () => {
    // "11" on the NB side is NOT a variation; a fetched "11b" that is a
    // variation must not fall back to a stem match for it.
    const nbCards = [nb({ id: "n1", cardNumber: "11", cardName: "Ken Griffey" })];
    const parallelCards = [
      fetched({
        ref: "p1",
        cardNumber: "11b",
        cardName: "Ken Griffey",
        isVariation: true,
        cardVariation: "Action",
      }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({ kind: "none" });
  });

  test("a later number tier never widens an earlier one that already found candidates", () => {
    // Two fetched rows share the exact number; a stripped/stem tier that would
    // otherwise find only one must not be consulted once the exact tier has
    // already produced (ambiguous) candidates.
    const nbCards = [nb({ id: "n1", cardNumber: "10", cardName: "Someone Else" })];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "10", cardName: "Someone Else" }),
      fetched({ ref: "p2", cardNumber: "10", cardName: "Someone Else" }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({ kind: "ambiguous" });
  });
});

describe("linkCardsToSide — who is on the card", () => {
  test("pendingPlayerNames count as names on the card", () => {
    const nbCards = [
      nb({ id: "n1", cardNumber: "5", cardName: "Rookie Card", namesOnCard: ["Some Rookie"] }),
    ];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "5", cardName: "Some Rookie", players: ["Some Rookie"] }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")?.kind).toBe("linked");
  });

  test("a card with no fetched players falls back to the fetched cardName", () => {
    const nbCards = [
      nb({ id: "n1", cardNumber: "5", cardName: "Ken Griffey", namesOnCard: ["Ken Griffey"] }),
    ];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "5", cardName: "Ken Griffey", players: [] }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")?.kind).toBe("linked");
  });

  test("a team card matches on number alone, ignoring name", () => {
    const nbCards = [
      nb({ id: "n1", cardNumber: "7", cardName: "Yankees Team Card", namesOnCard: [], isTeamCard: true }),
    ];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "7", cardName: "New York Yankees", players: [] }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")?.kind).toBe("linked");
  });

  test("mismatched names on an otherwise-matching number leave the card unlinked", () => {
    const nbCards = [nb({ id: "n1", cardNumber: "5", namesOnCard: ["Ken Griffey"] })];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "5", cardName: "Someone Else", players: ["Someone Else"] }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({ kind: "none" });
    expect(result.none).toBe(1);
  });
});

describe("linkCardsToSide — several variations of one card, by variation name", () => {
  test("the variation's own name narrows several same-number candidates to one", () => {
    const nbCards = [
      nb({
        id: "n1",
        cardNumber: "11",
        cardName: "Ken Griffey",
        isVariation: true,
        cardVariation: "Team Color",
      }),
    ];
    const parallelCards = [
      fetched({
        ref: "p-action",
        cardNumber: "11",
        cardName: "Ken Griffey",
        isVariation: true,
        cardVariation: "Action",
      }),
      fetched({
        ref: "p-color",
        cardNumber: "11",
        cardName: "Ken Griffey",
        isVariation: true,
        cardVariation: "Team Color",
      }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({
      kind: "linked",
      card: parallelCards[1],
      via: "key",
    });
  });

  test("when the variation name still leaves more than one, the card is ambiguous", () => {
    const nbCards = [
      nb({
        id: "n1",
        cardNumber: "11",
        cardName: "Ken Griffey",
        isVariation: true,
        cardVariation: "Action",
      }),
    ];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "11", cardName: "Ken Griffey", isVariation: true, cardVariation: "Action" }),
      fetched({ ref: "p2", cardNumber: "11", cardName: "Ken Griffey", isVariation: true, cardVariation: "Action" }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({ kind: "ambiguous" });
  });
});

describe("linkCardsToSide — the spelling fallback (number + shared surname)", () => {
  test("a differently-spelled name still links by number when a surname agrees", () => {
    const nbCards = [
      nb({ id: "n1", cardNumber: "5", cardName: "Jose Ramirez Jr.", namesOnCard: ["Jose Ramirez Jr."] }),
    ];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "5", cardName: "José Ramírez", players: ["José Ramírez"] }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({ kind: "linked", card: parallelCards[0], via: "number" });
  });

  test("a different player on the same number is never linked by the spelling fallback", () => {
    const nbCards = [
      nb({ id: "n1", cardNumber: "5", cardName: "Ken Griffey", namesOnCard: ["Ken Griffey"] }),
    ];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "5", cardName: "Someone Else", players: ["Someone Else"] }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({ kind: "none" });
  });

  test("the fallback never fires when the full key already found a candidate elsewhere", () => {
    // n1's full key is ambiguous (ties with n2); the number fallback must not
    // rescue it even though a surname would otherwise agree.
    const nbCards = [
      nb({ id: "n1", cardNumber: "5", cardName: "Ken Griffey", namesOnCard: ["Ken Griffey"] }),
      nb({ id: "n2", cardNumber: "5", cardName: "Ken Griffey Jr.", namesOnCard: ["Ken Griffey Jr."] }),
    ];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "5", cardName: "Ken Griffey", players: ["Ken Griffey"] }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    // n1 matches exactly by key (Ken Griffey == Ken Griffey) — fine, it links.
    // n2 has no full-key candidate, but the ref is already claimed via n1's
    // full key, so the fallback must not also propose it for n2.
    expect(result.outcomes.get("n1")?.kind).toBe("linked");
    expect(result.outcomes.get("n2")).toEqual({ kind: "none" });
  });
});

describe("linkCardsToSide — the earlier-link tiebreak", () => {
  test("an ambiguous card resolves to the ref its earlier link already held", () => {
    const nbCards = [
      nb({ id: "n1", cardNumber: "10", namesOnCard: [], cardName: "Team Card", isTeamCard: true }),
    ];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "10", cardName: "A" }),
      fetched({ ref: "p2", cardNumber: "10", cardName: "B" }),
    ];
    const earlierRefsByKey = new Map([
      [
        "10\u0000#team\u00000",
        new Set(["p2"]),
      ],
    ]);
    const result = linkCardsToSide(nbCards, parallelCards, {}, { earlierRefsByKey });
    expect(result.outcomes.get("n1")).toEqual({ kind: "linked", card: parallelCards[1], via: "earlierLink" });
  });

  test("two cards whose earlier links both point at the same ref both stay ambiguous", () => {
    const nbCards = [
      nb({ id: "n1", cardNumber: "10", namesOnCard: [], cardName: "Team Card", isTeamCard: true }),
      nb({ id: "n2", cardNumber: "10", namesOnCard: [], cardName: "Team Card 2", isTeamCard: true }),
    ];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "10", cardName: "A" }),
      fetched({ ref: "p2", cardNumber: "10", cardName: "B" }),
    ];
    // Both n1 and n2 key the same (identical isTeamCard cardKey), so both
    // propose the same earlier ref p2 — the proposal is refused for both.
    const earlierRefsByKey = new Map([["10\u0000#team\u00000", new Set(["p2"])]]);
    const result = linkCardsToSide(nbCards, parallelCards, {}, { earlierRefsByKey });
    expect(result.outcomes.get("n1")).toEqual({ kind: "ambiguous" });
    expect(result.outcomes.get("n2")).toEqual({ kind: "ambiguous" });
  });
});

describe("linkCardsToSide — unclaimed", () => {
  test("a fetched card no NB card ever proposed for is unclaimed", () => {
    const nbCards = [nb({ id: "n1", cardNumber: "1", cardName: "A", namesOnCard: ["A"] })];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "1", cardName: "A", players: ["A"] }),
      fetched({ ref: "p2", cardNumber: "2", cardName: "B", players: ["B"] }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.unclaimed).toEqual([parallelCards[1]]);
  });

  test("a fetched card that was a candidate but lost the guard is not unclaimed", () => {
    const nbCards = [nb({ id: "n1", cardNumber: "10", namesOnCard: [], cardName: "Team Card", isTeamCard: true })];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "10", cardName: "A" }),
      fetched({ ref: "p2", cardNumber: "10", cardName: "B" }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({ kind: "ambiguous" });
    expect(result.unclaimed).toEqual([]);
  });
});

describe("linkCardsToSide — the guard (invariant 7)", () => {
  test("two candidates for one card leaves it ambiguous, not a guess", () => {
    const nbCards = [nb({ id: "n1", cardNumber: "10", namesOnCard: [], cardName: "Team Card", isTeamCard: true })];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "10", cardName: "A" }),
      fetched({ ref: "p2", cardNumber: "10", cardName: "B" }),
    ];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({ kind: "ambiguous" });
    expect(result.ambiguous).toBe(1);
  });

  test("one fetched card two NB cards both want is claimed by neither", () => {
    const nbCards = [
      nb({ id: "n1", cardNumber: "10", namesOnCard: [], cardName: "Team Card", isTeamCard: true }),
      nb({ id: "n2", cardNumber: "10", namesOnCard: [], cardName: "Team Card 2", isTeamCard: true }),
    ];
    const parallelCards = [fetched({ ref: "p1", cardNumber: "10", cardName: "Whatever" })];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({ kind: "ambiguous" });
    expect(result.outcomes.get("n2")).toEqual({ kind: "ambiguous" });
    expect(result.ambiguous).toBe(2);
    expect(result.linked).toBe(0);
  });

  test("no candidate at all counts the card as none, not ambiguous", () => {
    const nbCards = [nb({ id: "n1", cardNumber: "99", namesOnCard: ["Nobody Fetched"] })];
    const parallelCards = [fetched({ ref: "p1", cardNumber: "10", cardName: "Someone" })];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect(result.outcomes.get("n1")).toEqual({ kind: "none" });
    expect(result.none).toBe(1);
    expect(result.ambiguous).toBe(0);
  });

  test("results carry one entry per NB card, in input order, for a mixed batch", () => {
    const nbCards = [
      nb({ id: "linked", cardNumber: "1", cardName: "A", namesOnCard: ["A"] }),
      nb({ id: "none", cardNumber: "2", cardName: "B", namesOnCard: ["B"] }),
    ];
    const parallelCards = [fetched({ ref: "p1", cardNumber: "1", cardName: "A", players: ["A"] })];
    const result = linkCardsToSide(nbCards, parallelCards);
    expect([...result.outcomes.keys()]).toEqual(["linked", "none"]);
    expect(result.linked).toBe(1);
    expect(result.none).toBe(1);
  });
});

describe("linkCardsToSide — numbers read as printed (NEO-489)", () => {
  const who = (name: string) => ({ cardName: name, namesOnCard: [name] });
  const theirs = (name: string) => ({ cardName: name, players: [name] });

  test("1a and 1A on both sides each link to their own exact card", () => {
    const nbCards = [
      nb({ id: "lo", cardNumber: "1a", ...who("Low Player") }),
      nb({ id: "up", cardNumber: "1A", ...who("Up Player") }),
    ];
    const parallelCards = [
      fetched({ ref: "pLo", cardNumber: "1a", ...theirs("Low Player") }),
      fetched({ ref: "pUp", cardNumber: "1A", ...theirs("Up Player") }),
    ];
    const r = linkCardsToSide(nbCards, parallelCards);
    expect(r.outcomes.get("lo")).toMatchObject({ kind: "linked", card: parallelCards[0] });
    expect(r.outcomes.get("up")).toMatchObject({ kind: "linked", card: parallelCards[1] });
  });

  test("with a case-only twin on the NB side, 1A links to 1A and 1a is left unlinked, not folded onto 1A", () => {
    const nbCards = [nb({ id: "up", cardNumber: "1A" }), nb({ id: "lo", cardNumber: "1a" })];
    const parallelCards = [fetched({ ref: "pUp", cardNumber: "1A" })];
    const r = linkCardsToSide(nbCards, parallelCards);
    expect(r.outcomes.get("up")).toMatchObject({ kind: "linked", card: parallelCards[0] });
    expect(r.outcomes.get("lo")).toEqual({ kind: "none" });
  });

  test("with a case-only twin on the fetched side, a differently-cased NB number does not fold onto either", () => {
    const nbCards = [nb({ id: "n", cardNumber: "x1a" })];
    const parallelCards = [
      fetched({ ref: "p1", cardNumber: "X1A" }),
      fetched({ ref: "p2", cardNumber: "X1a" }),
    ];
    const r = linkCardsToSide(nbCards, parallelCards);
    expect(r.outcomes.get("n")).toEqual({ kind: "none" });
  });

  test("a twin also blocks the variation stem tier for that number", () => {
    const nbCards = [
      nb({ id: "a", cardNumber: "11B", isVariation: true }),
      nb({ id: "b", cardNumber: "11b", isVariation: true }),
    ];
    const parallelCards = [fetched({ ref: "p", cardNumber: "11" })];
    const r = linkCardsToSide(nbCards, parallelCards);
    expect(r.outcomes.get("a")).toEqual({ kind: "none" });
    expect(r.outcomes.get("b")).toEqual({ kind: "none" });
  });

  test("with no twin, a case-only difference still links through the folded tier", () => {
    const nbCards = [nb({ id: "n", cardNumber: "ppr-dla" })];
    const parallelCards = [fetched({ ref: "p", cardNumber: "PPR-DLA" })];
    const r = linkCardsToSide(nbCards, parallelCards);
    expect(r.outcomes.get("n")).toMatchObject({ kind: "linked", card: parallelCards[0] });
  });

  test("a prefix strip keeps case: RC-10a links to 10a before any folding", () => {
    const nbCards = [nb({ id: "n", cardNumber: "RC-10a" })];
    const parallelCards = [fetched({ ref: "p", cardNumber: "10a" })];
    const r = linkCardsToSide(nbCards, parallelCards, { nb: "RC-" });
    expect(r.outcomes.get("n")).toMatchObject({ kind: "linked", card: parallelCards[0] });
  });

  test("cardKey keeps number case: 1a and 1A are different keys, spacing is still trimmed", () => {
    const base = { cardName: "P", namesOnCard: ["P"], isTeamCard: false, isVariation: false };
    expect(cardKey({ ...base, cardNumber: "1a" })).not.toBe(cardKey({ ...base, cardNumber: "1A" }));
    expect(cardKey({ ...base, cardNumber: " 1a " })).toBe(cardKey({ ...base, cardNumber: "1a" }));
  });
});
