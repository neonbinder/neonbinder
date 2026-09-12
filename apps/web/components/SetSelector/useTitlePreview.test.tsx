/**
 * NEO-272 — the title source chips, and the manufacturer row that must not
 * appear among them.
 *
 * `titleSourceChips` is a pure function, so it is tested as one: the two
 * component suites that render it (`TitleFixer.test.tsx`,
 * `CardDetailPanel.titleLimits.test.tsx`) pin what the chip ROW looks like in
 * each dialog, which is a different question from which chips a given set of
 * inputs produces and in what order. Ordering is the part with no natural home
 * over there — asserting fourteen chips through a rendered `<ul>` would test
 * the markup twice and the function once.
 *
 * The negative case is the point of the file. When NB has not identified a
 * set's brand, the set hangs off the marketplace's all-brands filter option —
 * a row that names no maker — the generator spends no title characters on it,
 * and the chips exist to tell an operator where the characters went. So a
 * Maker chip for one is a lie in the one place an operator goes to trust it.
 * It is suppressed off an NB flag on the row, never off the manufacturer's
 * name: that name is a marketplace filter label NB does not own and it decides
 * nothing (CLAUDE.md, product invariant 4), which is why nothing in this file
 * knows what such a row is called, and nothing in the module under test can be
 * made to care by renaming one.
 *
 * `.test.tsx`, not `.test.ts`: `vitest.include.mjs` collects components tests
 * as `components/ ** / *.test.tsx` only, and a `.test.ts` here would never run.
 * Same note as `baseRole.test.tsx`, same reason.
 */

import { describe, expect, it } from "vitest";

import { titleSourceChips } from "./useTitlePreview";

type PreviewInputs = Parameters<typeof titleSourceChips>[0];

/**
 * A preview carrying one of everything, so a suppressed chip shows up as a
 * hole in a known sequence rather than as a shorter list of unknown shape.
 */
function fullInputs(overrides: Partial<PreviewInputs> = {}): PreviewInputs {
  return {
    cardNumber: "300b",
    playerNames: ["Julio Rodriguez"],
    year: "2024",
    manufacturer: "Topps",
    setName: "Chrome",
    parallelName: "Refractor",
    isRookie: true,
    isRelic: true,
    autographed: "AUTO",
    shortPrint: "SSP",
    printRun: 199,
    cardVariation: "Wearing sunglasses",
    teamNames: ["Seattle Mariners"],
    sport: "Baseball",
    ...overrides,
  };
}

/** `["Year", "Maker", …]` — what the row reads like, left to right. */
const labels = (inputs: PreviewInputs): string[] =>
  titleSourceChips(inputs).map((c) => c.label);

/** `["Year:2024", …]` — labels AND values, for the unchanged-chips guard. */
const pairs = (inputs: PreviewInputs): string[] =>
  titleSourceChips(inputs).map((c) => `${c.label}:${c.value}`);

const FULL_ORDER = [
  "Year",
  "Maker",
  "Set",
  "Player",
  "Number",
  "Auto",
  "Relic",
  "Parallel",
  "Print run",
  "Variation",
  "Rookie",
  "Short print",
  "Team",
  "Sport",
];

describe("titleSourceChips — the Maker chip (NEO-272)", () => {
  it("shows the maker when it is a real manufacturer", () => {
    const chips = titleSourceChips(fullInputs({ manufacturerBrandUnknown: false }));

    expect(chips).toContainEqual({ label: "Maker", value: "Topps" });
    expect(chips.map((c) => c.label)).toEqual(FULL_ORDER);
  });

  it("omits the maker when NB has not identified the set's brand", () => {
    const chips = titleSourceChips(fullInputs({ manufacturerBrandUnknown: true }));

    expect(chips.some((c) => c.label === "Maker")).toBe(false);
    // And not merely blanked or emptied: the name must not reach the row by
    // any label, since the generator never put it in the title.
    expect(chips.some((c) => c.value === "Topps")).toBe(false);
  });

  it("suppresses ONLY the maker — every other chip keeps its order and value", () => {
    const real = fullInputs({ manufacturerBrandUnknown: false });
    const brandUnknown = fullInputs({ manufacturerBrandUnknown: true });

    expect(labels(brandUnknown)).toEqual(FULL_ORDER.filter((l) => l !== "Maker"));
    // The strongest form of "nothing else moved": the surviving chips are the
    // real-manufacturer row with exactly one entry removed, values included.
    expect(pairs(brandUnknown)).toEqual(pairs(real).filter((p) => !p.startsWith("Maker:")));
  });

  it("treats a preview that predates the flag as a real manufacturer", () => {
    // A browser holding this bundle can be reading an older deploy whose
    // `previewListingTitle` never returned the field. That preview's title DID
    // spend characters on its maker, so the chip belongs — and reading an
    // absent flag must not throw inside a modal dialog either way.
    const legacy = fullInputs();
    expect("manufacturerBrandUnknown" in legacy).toBe(false);

    expect(() => titleSourceChips(legacy)).not.toThrow();
    expect(titleSourceChips(legacy)).toContainEqual({ label: "Maker", value: "Topps" });
    expect(labels(legacy)).toEqual(FULL_ORDER);
  });

  it("renders no Maker chip when there is no manufacturer at all, flag or not", () => {
    // The pre-existing behaviour, restated so the new branch cannot be read as
    // the only way a Maker chip goes missing.
    for (const flag of [undefined, false, true]) {
      const chips = titleSourceChips(
        fullInputs({ manufacturer: undefined, manufacturerBrandUnknown: flag }),
      );
      expect(chips.some((c) => c.label === "Maker")).toBe(false);
      expect(chips.map((c) => c.label)).toEqual(FULL_ORDER.filter((l) => l !== "Maker"));
    }
  });

  it("keeps the flag out of the chips — it is a role, not a fact about the card", () => {
    // It never renders as a chip of its own under any label: the operator is
    // shown what the title was built from, not the reason a maker is missing.
    const chips = titleSourceChips(fullInputs({ manufacturerBrandUnknown: true }));
    expect(chips.every((c) => c.value !== "true")).toBe(true);
    expect(chips.length).toBe(FULL_ORDER.length - 1);
  });
});
