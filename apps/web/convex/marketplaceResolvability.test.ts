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
  missingBscChecklistScope,
  resolveBscFacetFilters,
} from "./bscFacets";
import {
  BSC_REQUIRED_LEVELS,
  NO_MARKETPLACE_IDS_MESSAGE,
  SL_ATTACH_REQUIRED_LEVELS,
  SL_REQUIRED_LEVELS,
  missingSummary,
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


// ===========================================================================
// NEO-252 — the CHECKLIST gate is judged per FACET, not per level
// ===========================================================================

/**
 * The bug, in one sentence: the gate and the request builder answered "can BSC
 * be asked?" two different ways, and the gate's way could not see an id
 * attached to the leaf.
 *
 * `resolveBscFacetFilters` buckets ids by what each one IS (NEO-189 facet
 * tags), so a BSC `setName` id attached to a variantType row scopes the query
 * by a set. `resolvableSides`' level walk instead looked for an id ON the
 * setName ancestor row — and a set NeonBinder built itself has none, because
 * the operator attached the BSC set where the attach dialog lives: the variant
 * row. So the checklist skipped BSC for a request the adapter would have run.
 *
 * `bscScope: "checklist"` is the fix, and it is an OPT-IN rather than the new
 * default because the level rule is still the right answer for the callers
 * that are not fetching a checklist — see the parity block's closing tests.
 */
describe("resolvableSides — bscScope: 'checklist' (NEO-252)", () => {
  /** Sport and year linked; the set is NB's own, with no ids at all. */
  const handTypedSet = row("setName", { value: "My Hand Typed Set" });

  test("a leaf-attached BSC set + variant tag RESOLVES a hand-typed set", () => {
    // The headline case. Nothing on the setName row, everything on the leaf —
    // and the request this licenses is fully scoped: sport, year, setName,
    // variant.
    const chain = [
      linkedSport,
      linkedYear,
      handTypedSet,
      row("variantType", {
        value: "Base",
        bsc: { b0: "base", b1: "2024-topps" },
        facets: { b0: "variant", b1: "setName" },
      }),
    ];

    expect(resolvableSides(chain, { bscScope: "checklist" }).bsc).toEqual({
      served: true,
      resolvable: true,
      missing: [],
    });
    // …and this is a CHANGE, not a restatement: the per-level rule refuses the
    // very same chain, which is exactly the disagreement the ticket is about.
    expect(resolvableSides(chain).bsc.resolvable).toBe(false);
  });

  test("leaf setName + variantName but NO variant tag is refused, naming the facet", () => {
    // The other half of the ticket's scope decision: `variant` stays mandatory
    // (Jason, 2026-09-05). Without it BSC answers with the base cards plus
    // every insert and parallel in the set — a ~5000-card superset returned as
    // a 200. A `variantName` tag does not stand in for it: it narrows WITHIN
    // the variant axis, it does not supply one.
    const out = resolvableSides(
      [
        linkedSport,
        linkedYear,
        handTypedSet,
        row("variantType", { value: "My Hand Typed Variant" }),
        row("insert", {
          value: "Homefield Advantage",
          bsc: { b0: "2024-topps", b1: "homefield-advantage" },
          facets: { b0: "setName", b1: "variantName" },
        }),
      ],
      { bscScope: "checklist" },
    );

    expect(out.bsc.resolvable).toBe(false);
    expect(out.bsc.missing).toEqual(["facet=variant"]);
  });

  test("what is missing is a FACET NAME — never a row, never a row's value", () => {
    // NEO-47's property, restated for the new vocabulary. `missing` is logged,
    // and the level rule's entries are `setName=<the operator's set name>`. The
    // facet rule cannot produce that shape at all: its entire output alphabet
    // is the four facet names.
    const out = resolvableSides(
      [row("sport", { value: "Secret Internal Sport" })],
      { bscScope: "checklist" },
    );

    expect(out.bsc.missing).toEqual([
      "facet=sport",
      "facet=year",
      "facet=setName",
      "facet=variant",
    ]);
    expect(JSON.stringify(out.bsc)).not.toContain("Secret Internal Sport");
  });

  test("an untagged variantType slug still resolves nothing — NEO-189 holds", () => {
    // The corrupt class: a mis-saved Base mapping wrote a setName slug into a
    // variantType row. Untagged, `resolveBscFacetFilters` drops it (the level
    // rule answers `undefined` at variantType), so it supplies no `variant`
    // and the facet gate refuses — the same verdict the level gate reached, by
    // a different road. Reading the tag rather than the row is what keeps the
    // two agreeing here.
    const out = resolvableSides(
      [
        linkedSport,
        linkedYear,
        linkedSetName,
        row("variantType", { value: "Base", bsc: { b0: "base" } }),
      ],
      { bscScope: "checklist" },
    );
    expect(out.bsc.resolvable).toBe(false);
    expect(out.bsc.missing).toEqual(["facet=variant"]);
  });
});

// ===========================================================================
// The parity property — the gate and the request cannot disagree
// ===========================================================================

/**
 * This is the invariant NEO-252 actually buys, and it is worth more than any
 * one case above: for every chain, the checklist gate's verdict IS
 * `missingBscChecklistScope` applied to the filters the request would carry.
 *
 * Stated as a property over a table rather than as four more examples, because
 * the failure mode it guards is a future edit adding a condition to one side —
 * which is precisely how the original divergence appeared.
 */
describe("resolvableSides ⇄ resolveBscFacetFilters parity (NEO-252)", () => {
  const CHAINS: Array<[string, ResolvableRow[]]> = [
    ["empty", []],
    ["hand-typed sport only", [row("sport", { value: "E2E Test Sport 3" })]],
    ["sport linked, nothing else", [linkedSport]],
    ["sport + year linked", [linkedSport, linkedYear]],
    ["sport + year + set linked, no variant row", [linkedSport, linkedYear, linkedSetName]],
    [
      "the fully conventional chain",
      [linkedSport, linkedYear, linkedSetName, taggedBase],
    ],
    [
      "hand-typed set, BSC set attached at the leaf",
      [
        linkedSport,
        linkedYear,
        row("setName", { value: "My Hand Typed Set" }),
        row("variantType", {
          value: "Base",
          bsc: { b0: "base", b1: "2024-topps" },
          facets: { b0: "variant", b1: "setName" },
        }),
      ],
    ],
    [
      "the NEO-189 split — one Base row, two BSC sets",
      [
        linkedSport,
        linkedYear,
        linkedSetName,
        row("variantType", {
          value: "Base",
          bsc: { b0: "base", b1: "series-1", b2: "series-2" },
          facets: { b0: "variant", b1: "setName", b2: "setName" },
        }),
      ],
    ],
    [
      "untagged variantType — the corrupt class",
      [
        linkedSport,
        linkedYear,
        linkedSetName,
        row("variantType", { value: "Base", bsc: { b0: "base" } }),
      ],
    ],
    [
      "an insert under a tagged Base",
      [
        linkedSport,
        linkedYear,
        linkedSetName,
        taggedBase,
        row("insert", {
          value: "Homefield Advantage",
          bsc: { b0: "homefield-advantage" },
          facets: { b0: "variantName" },
        }),
      ],
    ],
    [
      "a chain broken in the middle",
      [linkedSport, row("year", { value: "2024", bsc: {} }), linkedSetName, taggedBase],
    ],
  ];

  test.each(CHAINS)(
    "%s — the gate's verdict is the filters' own verdict",
    (_name, chain) => {
      const gate = resolvableSides(chain, { bscScope: "checklist" });
      const filters = resolveBscFacetFilters(chain).filters;
      const missing = missingBscChecklistScope(filters);

      expect(gate.bsc.resolvable).toBe(missing.length === 0);
      expect(gate.bsc.missing).toEqual(missing.map((f) => `facet=${f}`));
    },
  );

  test("a LEVEL sync is not covered by the property — it asks a different question", () => {
    // `bscScope` defaults to "level", and it must: a selector sync's request
    // body is built per level, and its parent chain legitimately stops above
    // the levels a checklist needs. Judging the year sync by the checklist's
    // facets would refuse every sync that has not reached a set yet.
    const chain = [linkedSport];
    expect(resolvableSides(chain, { level: "year" }).bsc.resolvable).toBe(true);
    expect(
      missingBscChecklistScope(resolveBscFacetFilters(chain).filters),
    ).not.toEqual([]);
  });

  test("the level rule is untouched at a level sync, tag requirement included", () => {
    // The NEO-239 behaviour, re-pinned now that a second rule exists beside it.
    const untaggedBase = row("variantType", { value: "Base", bsc: { b0: "base" } });
    const out = resolvableSides(
      [linkedSport, linkedYear, linkedSetName, untaggedBase],
      { level: "insert" },
    );
    expect(out.bsc.resolvable).toBe(false);
    expect(out.bsc.missing).toEqual(["variantType=Base"]);
  });
});

// ===========================================================================
// SportLots' "is this a marketplace set at all" test reads the facet plan
// ===========================================================================

describe("the SL unlinked-set rule (NEO-252)", () => {
  /**
   * At `insert` and `parallel` SportLots answers with every set for the year
   * and brand, so it only means "this set's variants" once the set is a
   * marketplace set at all. The test was `rowHasSideId(setRow, "bsc")` — which
   * missed the same leaf attachment the BSC gate did, and refused SportLots on
   * a set that demonstrably IS linked to a BSC set.
   */
  const handTypedSet = row("setName", { value: "My Hand Typed Set" });

  test("a BSC set attached at the LEAF counts as linked", () => {
    const out = resolvableSides(
      [
        linkedSport,
        linkedYear,
        handTypedSet,
        row("variantType", {
          value: "Base",
          bsc: { b0: "base", b1: "2024-topps" },
          facets: { b0: "variant", b1: "setName" },
        }),
      ],
      { level: "insert" },
    );
    expect(out.sportlots.resolvable).toBe(true);
    expect(out.sportlots.missing).toEqual([]);
  });

  test("a set linked NOWHERE on the path is still refused", () => {
    // The ten-flow case the rule exists for: NB's own set, no marketplace id
    // anywhere on the path, and SL's year+brand list offered as its variants.
    const out = resolvableSides(
      [
        linkedSport,
        linkedYear,
        handTypedSet,
        row("variantType", { value: "My Hand Typed Variant" }),
      ],
      { level: "insert" },
    );
    expect(out.sportlots.resolvable).toBe(false);
    expect(out.sportlots.missing).toEqual(["unlinked set"]);
  });

  test("an SL id on the setName row still counts — the OR is intact", () => {
    const out = resolvableSides(
      [
        linkedSport,
        linkedYear,
        row("setName", { value: "Topps", sportlots: { s0: "884412" } }),
        row("variantType", { value: "Base" }),
      ],
      { level: "insert" },
    );
    expect(out.sportlots.resolvable).toBe(true);
  });

  test("an SL-FIRST build is linked — SportLots files no set level at all", () => {
    // Jason's 2027-Topps walkthrough, as a chain. SportLots has no setName
    // rung: its unit of attachment is one flat set id, and NB files that id on
    // the row it corresponds to — the variant. So a set built in NeonBinder and
    // then matched to SportLots ends up with its ONLY set link on the Base row,
    // and the setName row above it stays NB's own forever.
    //
    // Reading the setName row alone called that "unlinked set" and skipped
    // SportLots on every insert and parallel sync beneath it, which is the
    // whole SL-first build path.
    const out = resolvableSides(
      [
        linkedSport,
        linkedYear,
        handTypedSet,
        row("variantType", { value: "Base", sportlots: { s0: "884412" } }),
      ],
      { level: "insert" },
    );
    expect(out.sportlots.resolvable).toBe(true);
    expect(out.sportlots.missing).toEqual([]);
  });

  test("an SL id DEEPER than the variant row counts too", () => {
    // Nothing privileges the variantType rung; the id may sit on an insert or
    // parallel row just as legitimately. The scan is "setName row or below".
    const out = resolvableSides(
      [
        linkedSport,
        linkedYear,
        handTypedSet,
        row("variantType", { value: "Insert" }),
        row("insert", { value: "Homefield Advantage", sportlots: { s0: "884412" } }),
      ],
      { level: "insert" },
    );
    expect(out.sportlots.resolvable).toBe(true);
  });

  test("sport / year / manufacturer SL ids are SCOPE and never count as a link", () => {
    // The rule would delete itself otherwise. `sprt`, `yr` and `brd` are
    // already required by SL_SCOPE_BY_LEVEL at this level, so counting them as
    // evidence would make every chain that gets this far "linked" — including
    // the hand-made set whose whole-brand-year answer this exists to refuse.
    // Note the manufacturer here carries an SL id and the verdict is still no.
    const out = resolvableSides(
      [
        linkedSport,
        linkedYear,
        row("manufacturer", { value: "Topps", sportlots: { s0: "TP" } }),
        handTypedSet,
        row("variantType", { value: "My Hand Typed Variant" }),
      ],
      { level: "insert" },
    );
    expect(out.sportlots.resolvable).toBe(false);
    expect(out.sportlots.missing).toEqual(["unlinked set"]);
  });

  test("BSC-first and SL-first are the same shape, judged the same way", () => {
    // The symmetry the widening restored. Two builds of the same NB set — one
    // that met BuySportsCards first, one that met SportLots first — and the
    // only difference is which marketplace's id is on the Base row. Neither
    // marketplace is privileged, and neither is the NB setName row.
    const bscFirst = resolvableSides(
      [
        linkedSport,
        linkedYear,
        handTypedSet,
        row("variantType", {
          value: "Base",
          bsc: { b0: "base", b1: "2024-topps" },
          facets: { b0: "variant", b1: "setName" },
        }),
      ],
      { level: "insert" },
    );
    const slFirst = resolvableSides(
      [
        linkedSport,
        linkedYear,
        handTypedSet,
        row("variantType", { value: "Base", sportlots: { s0: "884412" } }),
      ],
      { level: "insert" },
    );
    expect(bscFirst.sportlots.resolvable).toBe(true);
    expect(slFirst.sportlots.resolvable).toBe(true);
  });
});

// ===========================================================================
// missingSummary — what a LOG is allowed to say about a skip
// ===========================================================================

/**
 * `missing` names NB ROWS, and `label()` renders them as `<level>=<value>` —
 * the operator's own text for a set or a sport they typed. NEO-47 keeps that
 * out of `selectorSyncStatus.message` because it is served to the browser; the
 * same reasoning applies to a Convex log, which is retained, searchable, and
 * read by people who are not the operator.
 *
 * NEO-252 introduced a client message with the value REMOVED from it and then
 * logged the value in its place, which is the leak moving rather than closing.
 * This function is what every skip log renders through now.
 */
describe("missingSummary", () => {
  test("strips an NB row's DISPLAY VALUE, keeping the level name", () => {
    const out = resolvableSides([
      row("sport", { value: "Secret Internal Sport" }),
      row("setName", { value: "Jason's Private Set" }),
    ]);

    const line = missingSummary(out.bsc);
    expect(line).toBe("2 (sport,setName)");
    expect(line).not.toContain("Secret Internal Sport");
    expect(line).not.toContain("Jason's Private Set");
  });

  test("keeps `facet=` whole — it is marketplace vocabulary, not a row", () => {
    const out = resolvableSides(
      [row("sport", { value: "Secret Internal Sport" })],
      { bscScope: "checklist" },
    );
    expect(missingSummary(out.bsc)).toBe(
      "4 (facet=sport,facet=year,facet=setName,facet=variant)",
    );
  });

  test("keeps `level=` whole — that is the level being fetched, not a row", () => {
    // BSC has no `manufacturer` axis, so a manufacturer sync pushes
    // `level=manufacturer`. The right-hand side there is NB TAXONOMY, the same
    // string the caller passed in, and it is the whole diagnostic.
    const out = resolvableSides([linkedSport, linkedYear], {
      level: "manufacturer",
    });
    expect(missingSummary(out.bsc)).toBe("1 (level=manufacturer)");
  });

  test("keeps the `unlinked set` sentinel — fixed text, nothing to strip", () => {
    const out = resolvableSides(
      [
        linkedSport,
        linkedYear,
        row("setName", { value: "My Hand Typed Set" }),
        row("variantType", { value: "My Hand Typed Variant" }),
      ],
      { level: "insert" },
    );
    expect(missingSummary(out.sportlots)).toBe("1 (unlinked set)");
  });

  test("a resolvable side summarises as 0", () => {
    const out = resolvableSides([linkedSport, linkedYear]);
    expect(missingSummary(out.sportlots)).toBe("0");
  });

  test("NO chain shape can put a row value in the summary", () => {
    // The property, over the same table the parity block uses plus the shapes
    // whose `missing` entries are `label()`-derived. Every row here is named
    // something that could not occur as a level, a facet or a slug, so any
    // leak is visible whatever route the entry took into `missing`.
    const POISON = "ZZ Operator Typed Value";
    const chain: ResolvableRow[] = [
      row("sport", { value: POISON }),
      row("year", { value: POISON }),
      row("manufacturer", { value: POISON }),
      row("setName", { value: POISON }),
      row("variantType", { value: POISON }),
      row("insert", { value: POISON }),
    ];

    for (const opts of [
      undefined,
      { level: "year" },
      { level: "insert" },
      { level: "parallel" },
      { level: "manufacturer" },
      { bscScope: "checklist" as const },
      { slRequired: SL_ATTACH_REQUIRED_LEVELS },
    ]) {
      const out = resolvableSides(chain, opts);
      for (const side of ["bsc", "sportlots"] as const) {
        expect(missingSummary(out[side])).not.toContain(POISON);
        // …while `missing` itself still identifies the row, which is the point
        // of splitting rendering from construction.
        expect(out[side].missing.length).toBeGreaterThan(0);
      }
    }
  });
});
