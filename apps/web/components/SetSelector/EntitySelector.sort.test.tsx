/**
 * NEO-224 (D5) — the order every column lists its rows in.
 *
 * All-digit names first, newest first (2026 above 1995); every other name
 * after them in plain alphabetical order; the two groups never interleave. The
 * old comparator compared two numeric names as numbers and any other pair as
 * strings, which is not a total order on a mixed column ("1995-96", "1996",
 * "Unknown"): the result then depended on which pairs the sort happened to
 * compare. The tests below pin the order AND the property that matters, that
 * it does not depend on the order the rows arrive in.
 */

import { render, screen } from "@testing-library/react";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../convex/_generated/api", () => ({
  api: { selectorOptions: { getSelectorOptions: "getSelectorOptions" } },
}));

const state: { items: unknown } = { items: [] };

vi.mock("convex/react", () => ({
  useQuery: () => state.items,
}));

import EntitySelector, {
  compareOptionNames,
  displayByValue,
} from "./EntitySelector";
import type { SelectorItem } from "./EntitySelector";

/** Deterministic shuffle (mulberry32) so a failure is reproducible. */
function shuffled<T>(input: readonly T[], seed: number): T[] {
  const out = [...input];
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const sortNames = (names: readonly string[]) =>
  [...names].sort(compareOptionNames);

/** Years, season labels, a padded duplicate of 995, and plain words. */
const MIXED = [
  "2026",
  "1999",
  "1995",
  "995",
  "0995",
  "1995-96",
  "2024-25",
  "Unknown",
  "Base",
  "Z-Set",
  "10",
  "9",
];

const MIXED_SORTED = [
  // all digits, newest first; "0995" and "995" tie on value, so text decides
  "2026",
  "1999",
  "1995",
  "0995",
  "995",
  "10",
  "9",
  // everything else, alphabetical (digits before letters)
  "1995-96",
  "2024-25",
  "Base",
  "Unknown",
  "Z-Set",
];

describe("compareOptionNames (NEO-224, D5)", () => {
  it("puts all-digit names first, numerically descending", () => {
    expect(sortNames(["1995", "2026", "1999", "9", "10"])).toEqual([
      "2026",
      "1999",
      "1995",
      "10",
      "9",
    ]);
  });

  it("puts every other name after the digits, alphabetically ascending", () => {
    expect(sortNames(["Unknown", "Base", "1995-96", "Alpha"])).toEqual([
      "1995-96",
      "Alpha",
      "Base",
      "Unknown",
    ]);
  });

  it("compares digits as numbers, not text (9 sorts below 10)", () => {
    expect(compareOptionNames("10", "9")).toBeLessThan(0);
    expect(compareOptionNames("9", "10")).toBeGreaterThan(0);
  });

  it("never lets a season label or a word slip between the years", () => {
    const sorted = sortNames(["Base", "1996", "1995-96", "1995", "Unknown"]);
    expect(sorted.slice(0, 2)).toEqual(["1996", "1995"]);
    expect(sorted.slice(2)).toEqual(["1995-96", "Base", "Unknown"]);
  });

  it("orders a mixed set exactly", () => {
    expect(sortNames(MIXED)).toEqual(MIXED_SORTED);
  });

  it.each([1, 2, 3, 7, 42, 1234, 99999])(
    "gives the same order for the same names however they arrive (shuffle seed %i)",
    (seed) => {
      expect(sortNames(shuffled(MIXED, seed))).toEqual(MIXED_SORTED);
    },
  );

  it("is antisymmetric for every pair, '0995' versus '995' included", () => {
    for (const a of MIXED) {
      for (const b of MIXED) {
        expect(
          Math.sign(compareOptionNames(a, b)) +
            Math.sign(compareOptionNames(b, a)),
        ).toBe(0);
      }
    }
  });

  it("is transitive for every triple (a <= b and b <= c implies a <= c)", () => {
    const names = [...MIXED, "", "1e3", "0x10", "007", "7", "0"];
    for (const a of names) {
      for (const b of names) {
        for (const c of names) {
          if (
            compareOptionNames(a, b) <= 0 &&
            compareOptionNames(b, c) <= 0
          ) {
            expect(compareOptionNames(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });

  it("treats only [0-9]+ as numeric: '', '1e3' and '0x10' are text", () => {
    // Number() would accept all three; none is a year a collector recognises.
    expect(compareOptionNames("2026", "1e3")).toBeLessThan(0);
    expect(compareOptionNames("2026", "0x10")).toBeLessThan(0);
    expect(compareOptionNames("2026", "")).toBeLessThan(0);
    expect(compareOptionNames("", "1e3")).toBeLessThan(0);
  });

  it("returns 0 only for identical names", () => {
    expect(compareOptionNames("1995", "1995")).toBe(0);
    expect(compareOptionNames("Base", "Base")).toBe(0);
    expect(compareOptionNames("0995", "995")).not.toBe(0);
  });
});

describe("EntitySelector row order (NEO-224, D5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function renderColumn(leadRow?: (item: SelectorItem) => boolean) {
    return render(
      <EntitySelector
        title="Years"
        query={"getSelectorOptions" as never}
        queryArgs={{ level: "year" } as never}
        selectedId={null}
        onSelect={vi.fn()}
        expanded={true}
        setExpanded={vi.fn()}
        getDisplayName={displayByValue as (i: SelectorItem) => string}
        selectedColor="bg-blue-100"
        leadRow={leadRow}
      />,
    );
  }
  const rowsOf = (names: readonly string[]) =>
    names.map((value) => ({ _id: `id-${value}`, value }));
  const listed = () => screen.getAllByRole("option").map((o) => o.textContent);

  it.each([1, 2, 3, 99])(
    "lists a mixed column in the pinned order whatever order the query returns (seed %i)",
    (seed) => {
      state.items = rowsOf(shuffled(MIXED, seed));
      renderColumn();

      expect(listed()).toEqual(MIXED_SORTED);
    },
  );

  it("puts a lead row ahead of both groups, the rest keeping their order", () => {
    state.items = rowsOf(shuffled(MIXED, 5));
    const lead = (item: SelectorItem) => item.value === "Unknown";
    renderColumn(lead);

    expect(listed()).toEqual(["Unknown", ...MIXED_SORTED.filter((n) => n !== "Unknown")]);
  });

  it("orders several lead rows among themselves by the same comparator", () => {
    state.items = rowsOf(["Base", "2026", "1999", "Unknown"]);
    const lead = (item: SelectorItem) =>
      item.value === "1999" || item.value === "Base";
    renderColumn(lead);

    expect(listed()).toEqual(["1999", "Base", "2026", "Unknown"]);
  });

  it("does not mutate the array the query returned", () => {
    const original = rowsOf(shuffled(MIXED, 8));
    const before = original.map((r) => r.value);
    state.items = original;
    renderColumn();

    expect(original.map((r) => r.value)).toEqual(before);
  });
});
