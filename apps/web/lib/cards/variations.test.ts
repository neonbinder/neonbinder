import { describe, expect, test } from "vitest";
import {
  cardNumberStem,
  displayVariationLabel,
  resolveVariationParents,
  suggestVariationPairings,
  variationLabelKey,
  type VariationCandidate,
} from "./variations";

/**
 * NEO-189. Every fixture is real data pulled live on 2026-08-27 — BSC via
 * `POST /seller/bulk-upload/results`, SportLots by walking `listcards.tpl` for
 * set 189991 as a logged-in seller.
 */

const parent = (cardNumber: string): VariationCandidate => ({
  cardNumber,
  isVariation: false,
});
const variation = (
  cardNumber: string,
  variationLabel?: string,
): VariationCandidate => ({ cardNumber, isVariation: true, variationLabel });

describe("cardNumberStem", () => {
  test("splits a numeric stem from an alpha suffix", () => {
    expect(cardNumberStem("11")).toBe("11");
    expect(cardNumberStem("11b")).toBe("11");
    expect(cardNumberStem("1a")).toBe("1");
    expect(cardNumberStem("110")).toBe("110");
  });

  test("is case-insensitive — 2022 Heritage ships one uppercase suffix", () => {
    expect(cardNumberStem("232C")).toBe("232");
  });

  test("an insert code with no numeric prefix is its own stem", () => {
    expect(cardNumberStem("CC-JA")).toBe("CC-JA");
    expect(cardNumberStem("MIR-AJ")).toBe("MIR-AJ");
  });
});

describe("resolveVariationParents — BSC shape (suffixed numbers)", () => {
  test("2021 Heritage #11 — bare parent, two suffixed variations", () => {
    const rows = [parent("11"), variation("11b", "Action"), variation("11c", "Throwback Alternate")];
    const { parentByIndex, unresolvedStems } = resolveVariationParents(rows);
    expect(parentByIndex.get(1)).toBe(0);
    expect(parentByIndex.get(2)).toBe(0);
    expect(unresolvedStems).toEqual([]);
  });

  test("COUNTER-EXAMPLE: 2021 Topps #1 — the parent is 1a, there is no bare #1", () => {
    const rows = [parent("1a"), variation("1b", "Sliding"), variation("1c", "In Dugout")];
    const { parentByIndex, unresolvedStems } = resolveVariationParents(rows);
    expect(parentByIndex.get(1)).toBe(0);
    expect(parentByIndex.get(2)).toBe(0);
    expect(unresolvedStems).toEqual([]);
  });

  test("a variation may be a different player entirely — 2021 Topps #52 Mantle/Bradley", () => {
    // Archie Bradley is the base card; 52b/52c/52d are Mickey Mantle "Legend"
    // short prints. Nothing here may assume shared identity.
    const rows = [parent("52"), variation("52b", "Legend"), variation("52c", "Legend")];
    const { parentByIndex } = resolveVariationParents(rows);
    expect(parentByIndex.get(1)).toBe(0);
    expect(parentByIndex.get(2)).toBe(0);
  });
});

describe("resolveVariationParents — SportLots shape (shared card numbers)", () => {
  test("2021 Heritage #11 on SL — parent and both variations all numbered 11", () => {
    // This is the case a cardNumber-keyed API cannot express at all.
    const rows = [
      parent("11"),
      variation("11", "Action"),
      variation("11", "Throwback Alternate"),
    ];
    const { parentByIndex, unresolvedStems } = resolveVariationParents(rows);
    expect(parentByIndex.get(1)).toBe(0);
    expect(parentByIndex.get(2)).toBe(0);
    expect(unresolvedStems).toEqual([]);
  });

  test("2021 Heritage #13 Bryce Harper on SL — five variations sharing one number", () => {
    const rows = [
      parent("13"),
      variation("13", "Action"),
      variation("13", "Missing Stars"),
      variation("13", "Nickname"),
      variation("13", "Team Color Swap"),
      variation("13", "Throwback Alternate"),
    ];
    const { parentByIndex, unresolvedStems } = resolveVariationParents(rows);
    expect([...parentByIndex.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(parentByIndex.values())).toEqual(new Set([0]));
    expect(unresolvedStems).toEqual([]);
  });
});

describe("resolveVariationParents — ambiguity is reported, not guessed", () => {
  test("ORPHAN: 2021 Heritage insert #251 — both rows are variations, no parent", () => {
    const rows = [variation("251", "Large Print"), variation("251", "Small Print")];
    const { parentByIndex, unresolvedStems } = resolveVariationParents(rows);
    expect(parentByIndex.size).toBe(0);
    expect(unresolvedStems).toEqual(["251"]);
  });

  test("AMBIGUOUS: a stem shared by two unrelated non-variation cards", () => {
    const rows = [variation("18", "Yellow under C and S"), parent("18"), parent("18")];
    const { parentByIndex, unresolvedStems } = resolveVariationParents(rows);
    expect(parentByIndex.size).toBe(0);
    expect(unresolvedStems).toEqual(["18"]);
  });

  test("a set with no variations produces no links and no complaints", () => {
    const { parentByIndex, unresolvedStems } = resolveVariationParents([
      parent("110"),
      parent("111"),
      parent("CC-JA"),
    ]);
    expect(parentByIndex.size).toBe(0);
    expect(unresolvedStems).toEqual([]);
  });

  test("insert codes with no numeric stem never group together", () => {
    const { parentByIndex, unresolvedStems } = resolveVariationParents([
      parent("CC-JA"),
      parent("CC-JA"),
      parent("MIR-AJ"),
    ]);
    expect(parentByIndex.size).toBe(0);
    expect(unresolvedStems).toEqual([]);
  });
});

/**
 * Label helpers. Normalisation only — neither decides what a label MEANS.
 */
describe("variationLabelKey", () => {
  test("folds casing and internal whitespace so one label has one key", () => {
    expect(variationLabelKey("Action Image")).toBe("action image");
    expect(variationLabelKey("  action   IMAGE ")).toBe("action image");
  });

  test("an empty label has an empty key, so callers can skip it", () => {
    expect(variationLabelKey("   ")).toBe("");
  });
});

describe("displayVariationLabel", () => {
  test("normalises whitespace and otherwise leaves the label exactly as sent", () => {
    expect(displayVariationLabel("  Team Name  Color Swap ")).toBe(
      "Team Name Color Swap",
    );
    expect(displayVariationLabel("City / Throwback")).toBe("City / Throwback");
  });
});

/**
 * NEO-189 — pairing suggestions are computed per set and thrown away. Nothing
 * about what a marketplace calls a variation is stored; the durable output of a
 * confirmed pairing is the two platform refs on the card row.
 *
 * Labels below are the real ones from 2021 Topps Heritage.
 */
describe("suggestVariationPairings", () => {
  test("identical wording pairs exactly — the easy majority", () => {
    const { pairs, unpairedLeft, unpairedRight } = suggestVariationPairings(
      ["Missing Stars", "Nickname", "Error"],
      ["Nickname", "Error", "Missing Stars"],
    );
    expect(pairs).toHaveLength(3);
    expect(pairs.every((p) => p.basis === "exact")).toBe(true);
    expect(unpairedLeft).toEqual([]);
    expect(unpairedRight).toEqual([]);
  });

  test("one side being the other plus a qualifier is suggested, not asserted", () => {
    // BSC "Action" vs SL "Action Image"; BSC "Alternate" vs SL "Throwback Alternate".
    const { pairs } = suggestVariationPairings(
      ["Action", "Alternate"],
      ["Action Image", "Throwback Alternate"],
    );
    expect(pairs).toEqual([
      { leftIndex: 0, rightIndex: 0, basis: "contains" },
      { leftIndex: 1, rightIndex: 1, basis: "contains" },
    ]);
  });

  test("THE CASE THAT NEEDS A HUMAN: Team Color vs Team Name Color Swap", () => {
    // Neither contains the other. No string rule makes this a safe automatic
    // call, so it is reported rather than guessed.
    const { pairs, unpairedLeft, unpairedRight } = suggestVariationPairings(
      ["Team Color"],
      ["Team Name Color Swap"],
    );
    expect(pairs).toEqual([]);
    expect(unpairedLeft).toEqual([0]);
    expect(unpairedRight).toEqual([0]);
  });

  test("an exact match is never stolen by a longer containment match", () => {
    const { pairs } = suggestVariationPairings(
      ["Error"],
      ["Error, Missing name on front", "Error"],
    );
    expect(pairs).toEqual([{ leftIndex: 0, rightIndex: 1, basis: "exact" }]);
  });

  test("the tightest containment wins when several could match", () => {
    const { pairs } = suggestVariationPairings(
      ["Alternate"],
      ["Alternate Action Image Variation", "Throwback Alternate"],
    );
    expect(pairs).toEqual([{ leftIndex: 0, rightIndex: 1, basis: "contains" }]);
  });

  test("casing and spacing do not affect pairing", () => {
    const { pairs } = suggestVariationPairings(
      ["  MISSING   stars "],
      ["Missing Stars"],
    );
    expect(pairs).toEqual([{ leftIndex: 0, rightIndex: 0, basis: "exact" }]);
  });

  test("no counterpart at all is reported on both sides", () => {
    const { pairs, unpairedLeft, unpairedRight } = suggestVariationPairings(
      ["City / Throwback"],
      [],
    );
    expect(pairs).toEqual([]);
    expect(unpairedLeft).toEqual([0]);
    expect(unpairedRight).toEqual([]);
  });

  test("a full 2021 Heritage card #13: five labels, four auto, one for the admin", () => {
    const bsc = ["Action", "Missing Stars", "Nickname", "Team Color", "Alternate"];
    const sl = [
      "Action Image",
      "Missing Stars",
      "Nickname",
      "Team Name Color Swap",
      "Throwback Alternate",
    ];
    const { pairs, unpairedLeft, unpairedRight } = suggestVariationPairings(bsc, sl);
    expect(pairs).toHaveLength(4);
    expect(unpairedLeft.map((i) => bsc[i])).toEqual(["Team Color"]);
    expect(unpairedRight.map((i) => sl[i])).toEqual(["Team Name Color Swap"]);
  });
});
