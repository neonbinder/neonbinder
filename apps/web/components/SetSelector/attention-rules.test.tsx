/**
 * NEO-339 — the walker's pure rules (attention-rules.ts), on their own. They
 * are shared by the walker and the set-build tool; the walker's and the tool's
 * tests exercise them through their own surfaces, this pins each rule at its
 * edge. (A `.tsx` file on purpose: a `.test.ts` under `components/` is
 * collected by nothing; see vitest.include.mjs.)
 */

import { describe, expect, test } from "vitest";
import {
  WALK_RANK,
  WALK_UNRANKED,
  careerHeading,
  isAwaitingTeamLookup,
  marketplaceHeading,
  playedHere,
  walkRankOfKind,
} from "./attention-rules";
import type { AttentionCardRow } from "./card-attention";

describe("walkRankOfKind", () => {
  test.each(Object.entries(WALK_RANK))("%s ranks as WALK_RANK says", (kind, rank) => {
    expect(walkRankOfKind(kind)).toBe(rank);
  });

  test("a kind this bundle does not know walks after every ranked kind (the ?? WALK_UNRANKED fallback)", () => {
    expect(walkRankOfKind("someKindFromANewerDeploy")).toBe(WALK_UNRANKED);
    expect(WALK_UNRANKED).toBeGreaterThan(Math.max(...Object.values(WALK_RANK)));
  });

  test("an empty kind is unranked too", () => {
    expect(walkRankOfKind("")).toBe(WALK_UNRANKED);
  });

  test("teams are asked before names, names before titles, and the three title kinds share a rank", () => {
    expect(WALK_RANK.missingTeam).toBeLessThan(WALK_RANK.unreviewedName);
    expect(WALK_RANK.unreviewedName).toBeLessThan(WALK_RANK.titleOverLimit);
    expect(new Set([WALK_RANK.titleOverLimit, WALK_RANK.titleTruncated, WALK_RANK.aspectValueOverLimit]).size).toBe(1);
  });
});

describe("isAwaitingTeamLookup", () => {
  const waiting: AttentionCardRow = { platformData: { bsc: { ref: "b-1" } } } as AttentionCardRow;
  const withRow = (over: Partial<AttentionCardRow>) => ({ ...waiting, ...over }) as AttentionCardRow;

  test("a BSC-linked card with no team and no verdict yet is waiting", () => {
    expect(isAwaitingTeamLookup(waiting)).toBe(true);
  });

  test.each([
    ["no BSC ref", withRow({ platformData: { sportlots: { ref: "s-1" } } })],
    ["the lookup has run", withRow({ teamCheckDoneAt: 1 })],
    ["an operator ruled it teamless", withRow({ teamNoneConfirmedAt: 1 })],
    ["it has a team", withRow({ teamOnCardIds: ["t1"] as never })],
    ["it has a typed team name", withRow({ pendingTeamNames: ["Cubs"] })],
  ])("not waiting: %s", (_why, row) => {
    expect(isAwaitingTeamLookup(row)).toBe(false);
  });

  test("an empty team list and an empty typed-name list still count as no team", () => {
    expect(isAwaitingTeamLookup(withRow({ teamOnCardIds: [], pendingTeamNames: [] }))).toBe(true);
  });
});

describe("the words", () => {
  test("playedHere joins one, two and three names", () => {
    expect(playedHere(["Jimmie Foxx"])).toBe("Jimmie Foxx played here");
    expect(playedHere(["Johnny Bench", "Pete Rose"])).toBe("Johnny Bench & Pete Rose played here");
    expect(playedHere(["A", "B", "C"])).toBe("A, B & C played here");
  });

  test("marketplaceHeading never names a marketplace and says the number of teams when several share the name", () => {
    expect(marketplaceHeading("Nationals", 1, true)).toBe("The listing names “Nationals” and the career agrees — Enter accepts it.");
    expect(marketplaceHeading("Nationals", 2, false)).toBe("The listing names “Nationals” — 2 teams share that name. Pick the one on the card.");
    expect(marketplaceHeading("Nationals", 1, false)).toBe("The listing names “Nationals” — pick it if it matches the card.");
    for (const h of [marketplaceHeading("X", 1, true), marketplaceHeading("X", 3, false), marketplaceHeading("X", 1, false)]) {
      expect(h).not.toMatch(/BSC|SportLots|BuySportsCards/i);
    }
  });

  test("careerHeading: in the set year, a disagreeing listing, and the two whole-career fallbacks", () => {
    expect(careerHeading(true, false)).toBe("Suggested from career history — Enter accepts these.");
    expect(careerHeading(true, true)).toBe("From the career — the listing names a different team, so pick the one on the card.");
    expect(careerHeading(false, false, 2024)).toBe("No 2024 team on file — here’s the whole career. Pick the one on the card.");
    expect(careerHeading(false, false)).toBe("No year on this set — here’s the whole career. Pick the one on the card.");
  });
});
