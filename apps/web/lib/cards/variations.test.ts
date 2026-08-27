import { describe, expect, test } from "vitest";
import {
  BOOTSTRAP_VARIATION_ALIASES,
  cardNumberStem,
  displayVariationLabel,
  resolveVariationParents,
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
 * The vocabulary itself is stored data an admin rules on (see
 * convex/variationTypes.ts). These helpers only make the lookup stable and the
 * seed honest — neither decides what a label MEANS.
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

describe("BOOTSTRAP_VARIATION_ALIASES", () => {
  test("is seed data only — every entry names both marketplaces' spelling", () => {
    for (const e of BOOTSTRAP_VARIATION_ALIASES) {
      expect(e.canonical.length).toBeGreaterThan(0);
      expect(e.bsc.length).toBeGreaterThan(0);
      expect(e.sportlots.length).toBeGreaterThan(0);
    }
  });

  test("covers the six pairs measured against live data", () => {
    expect(BOOTSTRAP_VARIATION_ALIASES.map((e) => e.canonical)).toEqual([
      "Action",
      "Throwback Alternate",
      "Team Color Swap",
      "Missing Stars",
      "Nickname",
      "Error",
    ]);
    const action = BOOTSTRAP_VARIATION_ALIASES[0];
    expect(action.bsc).toEqual(["Action"]);
    expect(action.sportlots).toEqual(["Action Image"]);
  });

  test("no canonical name is duplicated", () => {
    const names = BOOTSTRAP_VARIATION_ALIASES.map((e) =>
      variationLabelKey(e.canonical),
    );
    expect(new Set(names).size).toBe(names.length);
  });
});
