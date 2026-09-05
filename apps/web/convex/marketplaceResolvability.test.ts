/**
 * NEO-239 — the per-side resolvability table.
 *
 * This is the rule that replaced `isCustomSubtree`. The old one asked "did a
 * human type any row on this path?" and, if so, skipped BOTH marketplaces for
 * the whole subtree forever. The new one asks, per side, "does every ancestor
 * this side needs an id from actually carry one?".
 *
 * The table below is the behaviour change, stated as cases. Two of them are the
 * point of the ticket:
 *
 *   • a hand-added MANUFACTURER no longer poisons its subtree — BSC has no
 *     manufacturer facet to be missing, so BSC still resolves and the sets and
 *     cards below it sync;
 *   • a variantType row with an UNTAGGED BSC slot makes BSC unresolvable,
 *     rather than falling back to deriving the `variant` facet from the row's
 *     display value (a marketplace query built from an NB name) or, worse,
 *     sending no variant axis at all and getting the whole set back.
 *
 * Pure function, so these are plain unit tests — no convex-test harness.
 */

import { describe, expect, test } from "vitest";
import {
  BSC_REQUIRED_LEVELS,
  NO_MARKETPLACE_IDS_MESSAGE,
  SL_ATTACH_REQUIRED_LEVELS,
  SL_REQUIRED_LEVELS,
  resolvableSides,
  resolvedSideList,
  rowHasBscFacet,
  skippedSideList,
  type ResolvableRow,
} from "./marketplaceResolvability";

/** A chain node, with only the ids it is said to carry. */
function row(
  level: string,
  opts: {
    value?: string;
    bsc?: Record<string, string>;
    sportlots?: Record<string, string>;
    facets?: Record<string, "setName" | "variantName" | "variant">;
  } = {},
): ResolvableRow {
  return {
    level,
    value: opts.value ?? level,
    platformData: {
      ...(opts.bsc ? { bsc: opts.bsc } : {}),
      ...(opts.sportlots ? { sportlots: opts.sportlots } : {}),
    },
    ...(opts.facets ? { platformFacets: { bsc: opts.facets } } : {}),
  };
}

const linkedSport = row("sport", {
  value: "Baseball",
  bsc: { b0: "baseball" },
  sportlots: { s0: "BB" },
});
const linkedYear = row("year", {
  value: "2024",
  bsc: { b0: "2024" },
  sportlots: { s0: "2024" },
});
const linkedSetName = row("setName", {
  value: "Topps",
  bsc: { b0: "2024-topps" },
});
const taggedBase = row("variantType", {
  value: "Base",
  bsc: { b0: "base" },
  facets: { b0: "variant" },
});

describe("resolvableSides — the required levels", () => {
  test("BSC needs sport, year and setName; SportLots needs sport and year", () => {
    // Pinned as data, because these two sets ARE the rule and every gate in
    // the codebase now defers to them.
    expect([...BSC_REQUIRED_LEVELS].sort()).toEqual([
      "setName",
      "sport",
      "year",
    ]);
    expect([...SL_REQUIRED_LEVELS].sort()).toEqual(["sport", "year"]);
    // The attach pool adds `brd`: an unscoped SL set list is every brand in
    // the year, which is a different pool, not a wider one.
    expect([...SL_ATTACH_REQUIRED_LEVELS].sort()).toEqual([
      "manufacturer",
      "sport",
      "year",
    ]);
  });

  test("an empty chain resolves both sides — there is nothing to be missing", () => {
    // The top-level sport sync: no parent, no scope, and asking each
    // marketplace for its whole facet list is the query it means to send.
    const out = resolvableSides([]);
    expect(out.bsc.resolvable).toBe(true);
    expect(out.sportlots.resolvable).toBe(true);
    expect(resolvedSideList(out)).toEqual(["bsc", "sportlots"]);
    expect(skippedSideList(out)).toEqual([]);
  });
});

describe("resolvableSides — the per-side table", () => {
  test("a sport with ids on neither side skips BOTH — the old custom-subtree case", async () => {
    // Every Maestro fixture builds exactly this: a hand-typed "E2E Test Sport
    // N" with no marketplace presence. The skip must be immediate and total,
    // and it must land in the same place in the action as the flag-based one
    // did, or 37 flows that expect a column to go idle instantly start
    // waiting on a sync panel.
    const out = resolvableSides([row("sport", { value: "E2E Test Sport 3" })]);
    expect(out.bsc.resolvable).toBe(false);
    expect(out.sportlots.resolvable).toBe(false);
    expect(resolvedSideList(out)).toEqual([]);
    // `skippedSideList` is the exact inverse, and is what rides back to the
    // client as `skippedSides` for every caller to subtract from coverage.
    expect(skippedSideList(out)).toEqual(["bsc", "sportlots"]);
  });

  test("sport with a BSC id only: BSC resolves, SportLots is skipped", () => {
    const out = resolvableSides([
      row("sport", { value: "Baseball", bsc: { b0: "baseball" } }),
    ]);
    expect(out.bsc.resolvable).toBe(true);
    expect(out.sportlots.resolvable).toBe(false);
    expect(out.sportlots.missing).toEqual(["sport=Baseball"]);
  });

  test("sport + year linked on both sides: the setName sync runs on both", () => {
    const out = resolvableSides([linkedSport, linkedYear]);
    expect(resolvedSideList(out)).toEqual(["bsc", "sportlots"]);
  });

  test("A HAND-ADDED MANUFACTURER DOES NOT BLOCK BSC — the case the flag got wrong", () => {
    // The headline behaviour change. `isCustomSubtree` skipped both sides for
    // everything under a user-created row, so a manufacturer typed by hand
    // (which is normal — "All Brands" is created by the set sync itself) made
    // every set, variant and card beneath it unsyncable. BSC has NO
    // manufacturer facet at all (see LEVEL_TO_BSC_FACET), so there was never
    // anything for the missing id to break.
    const out = resolvableSides([
      linkedSport,
      linkedYear,
      row("manufacturer", { value: "All Brands" }), // no ids on either side
      linkedSetName,
    ]);
    expect(out.bsc.resolvable).toBe(true);
    expect(out.bsc.missing).toEqual([]);
    // SportLots is scoped by sport + year only, so it resolves too — the
    // manufacturer id is required for the ATTACH pool, not for this.
    expect(out.sportlots.resolvable).toBe(true);
  });

  test("that same manufacturer DOES block the SportLots ATTACH pool", () => {
    const out = resolvableSides(
      [linkedSport, linkedYear, row("manufacturer", { value: "All Brands" })],
      { slRequired: SL_ATTACH_REQUIRED_LEVELS },
    );
    expect(out.bsc.resolvable).toBe(true);
    expect(out.sportlots.resolvable).toBe(false);
    expect(out.sportlots.missing).toEqual(["manufacturer=All Brands"]);
  });

  test("a setName with no BSC id skips BSC and keeps SportLots", () => {
    const out = resolvableSides([
      linkedSport,
      linkedYear,
      row("setName", { value: "My Own Set" }),
    ]);
    expect(out.bsc.resolvable).toBe(false);
    expect(out.bsc.missing).toEqual(["setName=My Own Set"]);
    expect(out.sportlots.resolvable).toBe(true);
    expect(resolvedSideList(out)).toEqual(["sportlots"]);
  });

  test("a variantType with a `variant`-TAGGED slot resolves BSC", () => {
    const out = resolvableSides([
      linkedSport,
      linkedYear,
      linkedSetName,
      taggedBase,
    ]);
    expect(out.bsc.resolvable).toBe(true);
  });

  test("a variantType with an UNTAGGED BSC slot does NOT resolve BSC", () => {
    // The id may well be right — this is every row written before NEO-189 —
    // but an untagged BSC slug is not self-describing, and one class of them
    // is known to be a setName slug written into a variantType row by a
    // mis-saved Base mapping. Guessing it is the `variant` axis would
    // re-scope a live checklist; guessing nothing and sending no variant axis
    // returns the set's base cards plus every insert and parallel in it.
    const out = resolvableSides([
      linkedSport,
      linkedYear,
      linkedSetName,
      row("variantType", { value: "Base", bsc: { b0: "base" } }),
    ]);
    expect(out.bsc.resolvable).toBe(false);
    expect(out.bsc.missing).toEqual(["variantType=Base"]);
    // SportLots is untouched by any of this — it has no facet concept.
    expect(out.sportlots.resolvable).toBe(true);
  });

  test("a setName-tagged slot on a variantType is not a variant tag", () => {
    // NEO-189's motivating row: a Base drawing from two BSC setName sets. It
    // genuinely has setName slots — and it still needs a `variant` one, or the
    // query it sends has no variant axis.
    const out = resolvableSides([
      linkedSport,
      linkedYear,
      linkedSetName,
      row("variantType", {
        value: "Base",
        bsc: { b0: "series-1", b1: "series-2" },
        facets: { b0: "setName", b1: "setName" },
      }),
    ]);
    expect(out.bsc.resolvable).toBe(false);
  });

  test("a variantType with NO BSC slot at all does not resolve BSC either", () => {
    const out = resolvableSides([
      linkedSport,
      linkedYear,
      linkedSetName,
      row("variantType", { value: "Base" }),
    ]);
    expect(out.bsc.resolvable).toBe(false);
  });

  test("insert and parallel levels are never required on either side", () => {
    // Their ids NARROW a query. Absent, the query is still correctly scoped by
    // the set and the variant — just broader, which is not the fail-open shape
    // the required levels exist to prevent.
    const out = resolvableSides([
      linkedSport,
      linkedYear,
      linkedSetName,
      taggedBase,
      row("insert", { value: "Chrome Refractors" }),
      row("parallel", { value: "Gold /50" }),
    ]);
    expect(out.bsc.resolvable).toBe(true);
    expect(out.sportlots.resolvable).toBe(true);
  });

  test("a missing id is never substituted with the row's display value", () => {
    // The whole reason the four fallbacks came out. `missing` names the row
    // for the LOG; nothing in the result offers the value as a filter, and no
    // caller can mistake one for the other.
    const out = resolvableSides([row("sport", { value: "E2E Test Sport 3" })]);
    expect(out.bsc.missing).toEqual(["sport=E2E Test Sport 3"]);
    expect(JSON.stringify(out)).not.toContain('"filters"');
  });

  test("an EMPTY slot map counts the same as no slot map at all", () => {
    // `platformData: { bsc: {} }` is a real shape on the wire — a slot was
    // attached and then every entry detached, or a caller spread an empty
    // object rather than omitting the key. `rowHasSideId` must judge it by
    // entry count, not by whether the key is merely present; a regression
    // that checked `"bsc" in row.platformData` would treat this row as
    // resolvable and send BSC a request scoped by nothing.
    const out = resolvableSides([
      row("sport", { value: "Baseball", bsc: {}, sportlots: {} }),
    ]);
    expect(out.bsc.resolvable).toBe(false);
    expect(out.sportlots.resolvable).toBe(false);
    expect(out.bsc.missing).toEqual(["sport=Baseball"]);
  });

  test("an id on the OTHER side does not satisfy this one — SportLots-only sport", () => {
    // The mirror of "sport with a BSC id only" above. A regression that
    // treated "has ANY marketplace id" as satisfying BOTH sides (e.g.
    // `rowHasSideId(row, "bsc") || rowHasSideId(row, "sportlots")`) would pass
    // every test that only ever exercises the BSC-only direction.
    const out = resolvableSides([
      row("sport", { value: "Baseball", sportlots: { s0: "BB" } }),
    ]);
    expect(out.bsc.resolvable).toBe(false);
    expect(out.bsc.missing).toEqual(["sport=Baseball"]);
    expect(out.sportlots.resolvable).toBe(true);
  });

  test("a required level absent from the CHAIN ARRAY is not 'missing' — even mid-hierarchy", () => {
    // `resolvableSides` never assumes the hierarchy; it only judges rows it is
    // actually handed. Skipping `year` out of the array entirely (as opposed
    // to a `year` row present with no id) must not block BSC — that is the
    // documented "levels absent from the chain are not missing" rule, proven
    // for a level in the MIDDLE of the hierarchy, not just the leaf.
    const out = resolvableSides([linkedSport, linkedSetName]);
    expect(out.bsc.resolvable).toBe(true);
    expect(out.bsc.missing).toEqual([]);
  });

  test("a chain broken in the MIDDLE (year has no BSC id) makes BSC unresolvable", () => {
    // Not just the top or the leaf — every ancestor is checked independently.
    const brokenYear = row("year", { value: "2024", bsc: {} });
    const out = resolvableSides([linkedSport, brokenYear, linkedSetName]);
    expect(out.bsc.resolvable).toBe(false);
    expect(out.bsc.missing).toEqual(["year=2024"]);
  });
});

describe("skippedSideList", () => {
  test("is the exact inverse of resolvedSideList", () => {
    const oneSide = resolvableSides([
      row("sport", { value: "Baseball", sportlots: { s0: "BB" } }),
    ]);
    expect(resolvedSideList(oneSide)).toEqual(["sportlots"]);
    expect(skippedSideList(oneSide)).toEqual(["bsc"]);
  });

  test("carries no row values — it is side names only", () => {
    // What the operator is TOLD is built from these names by
    // `skippedSyncMessage` (convex/selectorSyncStore.ts), which is where the
    // "no adapter text, no row values in reactive state" rule is enforced
    // (NEO-47). Nothing about a row can travel this far.
    const out = skippedSideList(
      resolvableSides([row("sport", { value: "Secret Internal Sport" })]),
    );
    expect(out).toEqual(["bsc", "sportlots"]);
  });
});

describe("rowHasBscFacet", () => {
  test("an untagged slot does not count, and neither does a differently-tagged one", () => {
    const untagged = row("variantType", { bsc: { b0: "base" } });
    expect(rowHasBscFacet(untagged, "variant")).toBe(false);

    const tagged = row("variantType", {
      bsc: { b0: "base", b1: "series-1" },
      facets: { b0: "variant", b1: "setName" },
    });
    expect(rowHasBscFacet(tagged, "variant")).toBe(true);
    expect(rowHasBscFacet(tagged, "setName")).toBe(true);
    expect(rowHasBscFacet(tagged, "variantName")).toBe(false);
  });
});
