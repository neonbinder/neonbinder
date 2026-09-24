/**
 * NEO-211 — the matcher's rules, asserted directly.
 *
 * These are pure-function tests on purpose. Every rule here also has a
 * through-the-mutation test in `selectorSyncAdditive.test.ts`; what this file
 * buys is the ability to state the rule in one line when it fails, rather than
 * inferring it from a row's final `platformData`. The two must not drift, and
 * they cannot, because both exercise the same module the stores call.
 */

import { describe, expect, test } from "vitest";
import {
  BRAND_UNKNOWN_RENAME_REFUSAL,
  checkSelectorValue,
  clearDeclinedIfLabelChanged,
  effectiveCoveredSides,
  isBrandUnknownRow,
  itemsReachPastSiblings,
  planSelectorSync,
  planValueRename,
  resolveReturnedIds,
  selectorValueKey,
  indistinguishableByMarketplaceIds,
  unlinkStalePrimary,
  type IncomingItem,
  type MatchableRow,
} from "./selectorSyncMatch";
import { SL_ALL_BRANDS_BRAND_ID, isSlAllBrandsBrandId } from "./slBrandAxis";

type Row = MatchableRow<string> & { level: string };

function row(
  id: string,
  value: string,
  over: Partial<Row> = {},
): Row {
  return {
    _id: id,
    value,
    level: "setName",
    platformData: {},
    ...over,
  };
}

function item(
  value: string,
  ids: IncomingItem["ids"] = {},
  existingId?: string,
): IncomingItem {
  return { value, ids, ...(existingId ? { existingId } : {}) };
}

describe("selectorValueKey", () => {
  test("folds case and surrounding whitespace, and NOTHING else", () => {
    expect(selectorValueKey("  Topps  ")).toBe("topps");
    // The fold deliberately stops here. `nameKey` would collapse both of these
    // to "gold50" and silently merge two different parallels into one row.
    expect(selectorValueKey("Gold /50")).not.toBe(selectorValueKey("Gold 50"));
  });
});

describe("resolveReturnedIds + effectiveCoveredSides", () => {
  const items = [item("A", { bsc: "b1" }), item("B", { sportlots: "s1" })];
  const fromItems = (its = items) => resolveReturnedIds(its, undefined);

  test("absent coveredSides covers NOTHING — silence is not evidence", () => {
    // The release-safety property: an old SPA bundle mid-deploy cannot say
    // "SportLots was down", so it says nothing, and nothing gets unlinked.
    expect(effectiveCoveredSides(fromItems(), undefined)).toEqual([]);
    expect(effectiveCoveredSides(fromItems(), [])).toEqual([]);
  });

  test("narrows a declared side whose returned-id universe is empty", () => {
    const bscOnly = [item("A", { bsc: "b1" })];
    expect(
      effectiveCoveredSides(fromItems(bscOnly), ["bsc", "sportlots"]),
    ).toEqual(["bsc"]);
  });

  test("declaring both with both present covers both", () => {
    expect(effectiveCoveredSides(fromItems(), ["bsc", "sportlots"])).toEqual([
      "bsc",
      "sportlots",
    ]);
  });

  test("an explicit returnedIds REPLACES the items as the universe", () => {
    // The reconciler case: the items are what the operator confirmed, the
    // returnedIds are what BSC actually listed. They are different lists and
    // only the second one is evidence about the marketplace.
    const resolved = resolveReturnedIds(items, { bsc: ["only-this-one"] });
    expect([...resolved.bsc]).toEqual(["only-this-one"]);
    // A side the caller omitted gets an EMPTY universe — never a silent
    // fall-back to the items, which is the bug this argument exists to fix.
    expect(resolved.sportlots.size).toBe(0);
    expect(effectiveCoveredSides(resolved, ["bsc", "sportlots"])).toEqual([
      "bsc",
    ]);
  });

  test("an explicitly EMPTY side is not covered", () => {
    const resolved = resolveReturnedIds(items, { bsc: [], sportlots: [] });
    expect(effectiveCoveredSides(resolved, ["bsc", "sportlots"])).toEqual([]);
  });
});

describe("planSelectorSync tiers", () => {
  test("tier 1: the sibling holding the incoming marketplace id wins", () => {
    const a = row("a", "Topps", { platformData: { bsc: { b0: "topps-2024" } } });
    const b = row("b", "Bowman", { platformData: { bsc: { b0: "bowman" } } });
    const plan = planSelectorSync({
      existing: [a, b],
      // Name says nothing (NB renamed it); the id says everything.
      items: [item("Topps Chewing Gum", { bsc: "topps-2024" })],
    });
    expect(plan.outcomes[0]).toEqual({
      kind: "matched",
      existingId: "a",
      tier: 1,
    });
  });

  test("tier 1 withholds when two siblings hold the same id (NEO-137 M:1)", () => {
    const a = row("a", "Series 1", {
      platformData: { bsc: { b0: "topps-2024" } },
    });
    const b = row("b", "Series 2", {
      platformData: { bsc: { b0: "topps-2024" } },
    });
    const plan = planSelectorSync({
      existing: [a, b],
      items: [item("Brand New Name", { bsc: "topps-2024" })],
    });
    // Not a match, and NOT an insert either: inserting a third row for an id
    // already held twice is how a duplicate cascade starts.
    expect(plan.outcomes[0].kind).toBe("withheld");
    expect(plan.ambiguities).toHaveLength(1);
  });

  test("tier 2: name matches a sibling with no id on that side, and attaches", () => {
    const a = row("a", "Topps");
    const plan = planSelectorSync({
      existing: [a],
      items: [item("topps", { bsc: "topps-2024" })],
    });
    expect(plan.outcomes[0]).toEqual({
      kind: "matched",
      existingId: "a",
      tier: 2,
    });
  });

  test("tier 2: a STALE id is free — this is how a BSC re-slug heals", () => {
    const a = row("a", "Topps", {
      platformData: { bsc: { b0: "topps-2024-old" } },
    });
    const plan = planSelectorSync({
      existing: [a],
      items: [item("Topps", { bsc: "topps-2024-new" })],
    });
    // The old slug did not come back, so the row is not "legitimately bound"
    // to anything upstream still lists — the new slug belongs to it.
    expect(plan.outcomes[0]).toEqual({
      kind: "matched",
      existingId: "a",
      tier: 2,
    });
  });

  test("tier 2 withholds when the name matches a row bound to a LIVE id", () => {
    const a = row("a", "Topps", {
      platformData: { bsc: { b0: "topps-a" } },
    });
    const plan = planSelectorSync({
      existing: [a],
      items: [
        item("Topps", { bsc: "topps-a" }), // keeps topps-a alive
        item("Topps", { bsc: "topps-b" }), // same name, different set
      ],
    });
    expect(plan.outcomes[0].kind).toBe("matched");
    // Not inserted: a second sibling called "Topps" would break the
    // one-name-per-parent rule every picker relies on.
    expect(plan.outcomes[1].kind).toBe("withheld");
  });

  test("two siblings already folding to one name withhold, never pick", () => {
    const a = row("a", "Topps");
    const b = row("b", "TOPPS");
    const plan = planSelectorSync({
      existing: [a, b],
      items: [item("Topps", { bsc: "topps-2024" })],
    });
    expect(plan.outcomes[0].kind).toBe("withheld");
    expect(plan.ambiguities[0].reason).toContain("share this name");
  });

  test("two incoming items folding to ONE existing row: first wins, second withheld", () => {
    const a = row("a", "Topps");
    const plan = planSelectorSync({
      existing: [a],
      items: [item("Topps", { bsc: "b1" }), item("topps", { sportlots: "s1" })],
    });
    expect(plan.outcomes[0]).toMatchObject({ kind: "matched", existingId: "a" });
    expect(plan.outcomes[1].kind).toBe("withheld");
  });

  test("no candidate at any tier → insert", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Topps")],
      items: [item("Bowman", { bsc: "bowman" })],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "insert" });
  });

  test("bsc and sportlots ids resolving to DIFFERENT rows withholds", () => {
    const a = row("a", "Topps", { platformData: { bsc: { b0: "b1" } } });
    const b = row("b", "Bowman", { platformData: { sportlots: { s0: "s1" } } });
    const plan = planSelectorSync({
      existing: [a, b],
      items: [item("Whatever", { bsc: "b1", sportlots: "s1" })],
    });
    // Upstream believes these are one set; NB has two. Merging rows is not a
    // decision a sync gets to make, and picking one would move a link silently.
    expect(plan.outcomes[0].kind).toBe("withheld");
  });
});

describe("planSelectorSync — ambiguity edge cases (NEO-211 adversarial pass)", () => {
  test("a marketplace id wins the match even when two siblings already share its NAME", () => {
    // Sibling name collisions only matter to TIER 2. An id is identity — once
    // tier 1 resolves cleanly, the fact that some OTHER pair of siblings
    // happens to collide on display value must not withhold or redirect it.
    const a = row("a", "Topps", { platformData: { bsc: { b0: "topps-2024" } } });
    const c = row("c", "Topps", { isCustom: true }); // a second sibling named "Topps"
    const plan = planSelectorSync({
      existing: [a, c],
      items: [item("Topps Chewing Gum", { bsc: "topps-2024" })],
    });
    expect(plan.outcomes[0]).toEqual({
      kind: "matched",
      existingId: "a",
      tier: 1,
    });
    // The custom sibling with the colliding name was never touched or renamed.
    expect(plan.ambiguities).toHaveLength(0);
  });

  test("an id held by two siblings AND naming one of them by value is still withheld — never a coin flip", () => {
    // NEO-137 M:1 legality means the id alone cannot disambiguate. The
    // incoming item's value happens to match ONE of the two holders, but a
    // name match is not allowed to break a tie an id match refused to make.
    const a = row("a", "Series 1", { platformData: { bsc: { b0: "shared-id" } } });
    const b = row("b", "Series 2", { platformData: { bsc: { b0: "shared-id" } } });
    const plan = planSelectorSync({
      existing: [a, b],
      items: [item("Series 1", { bsc: "shared-id" })],
    });
    expect(plan.outcomes[0].kind).toBe("withheld");
    // Nothing was matched or inserted — the ambiguity is reported, not guessed.
    expect(plan.outcomes[0]).not.toMatchObject({ kind: "matched" });
    expect(plan.outcomes[0]).not.toMatchObject({ kind: "insert" });
  });

  test("two incoming items sharing one marketplace id but different values: first wins, second withheld", () => {
    const a = row("a", "Topps", { platformData: { bsc: { b0: "shared-id" } } });
    const plan = planSelectorSync({
      existing: [a],
      items: [
        item("First Name", { bsc: "shared-id" }),
        item("Second Name", { bsc: "shared-id" }),
      ],
    });
    expect(plan.outcomes[0]).toMatchObject({ kind: "matched", existingId: "a" });
    expect(plan.outcomes[1].kind).toBe("withheld");
    expect(
      plan.ambiguities.some((a) =>
        a.reason.includes("resolve to one row by marketplace id"),
      ),
    ).toBe(true);
  });

  test("an id returned under DIFFERENT CASE is not the same id — falls through to the value fold", () => {
    // Ids are compared EXACTLY, never folded — only display values are folded.
    // A case-different id is treated as a re-slug: the same healing path a
    // brand-new slug takes, not a silent no-op and not two rows.
    const a = row("a", "Topps", { platformData: { bsc: { b0: "ABC123" } } });
    const plan = planSelectorSync({
      existing: [a],
      items: [item("Topps", { bsc: "abc123" })],
    });
    expect(plan.outcomes[0]).toEqual({
      kind: "matched",
      existingId: "a",
      tier: 2,
    });
  });
});

describe("planSelectorSync tier 0 (client-supplied existingId)", () => {
  test("matches only a row in the sibling snapshot", () => {
    const a = row("a", "Topps");
    const plan = planSelectorSync({
      existing: [a],
      items: [item("Renamed In Modal", {}, "a")],
    });
    expect(plan.outcomes[0]).toEqual({
      kind: "matched",
      existingId: "a",
      tier: 0,
    });
  });

  test("an existingId that is not a sibling falls through and inserts", () => {
    // The id may be a row at another level, under another parent, or deleted.
    // The matcher cannot tell those apart and does not try: it only ever
    // resolves against the snapshot the store already read.
    const plan = planSelectorSync({
      existing: [row("a", "Topps")],
      items: [item("Elsewhere", { bsc: "b9" }, "some-foreign-id")],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "insert" });
    expect(plan.ambiguities[0].reason).toContain("not a sibling");
  });

  test("two items claiming one existingId: first matches, second WITHHOLDS", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Topps")],
      items: [item("Topps One", {}, "a"), item("Topps Two", {}, "a")],
    });
    expect(plan.outcomes[0]).toMatchObject({ kind: "matched", existingId: "a" });
    // Withheld rather than inserted: an insert here creates a second sibling
    // sharing this row's name, and from then on tier 2 at this parent
    // withholds forever — one bad batch permanently disables name matching.
    expect(plan.outcomes[1]).toEqual({
      kind: "withheld",
      reason: "existingId already claimed in this batch",
    });
  });
});

describe("tier precedence and reporting", () => {
  test("an id claim beats a name claim regardless of item ORDER", () => {
    const r = row("r", "Topps", { platformData: { bsc: { b0: "topps-live" } } });
    const plan = planSelectorSync({
      existing: [r],
      items: [
        // Listed FIRST, and matches R by name…
        item("Topps", {}),
        // …but THIS one is holding R's marketplace id.
        item("Topps Renamed Upstream", { bsc: "topps-live" }),
      ],
    });
    // Identity wins. Before the two-pass split, the earlier name match claimed
    // R and the id match was withheld — the result depended on list order.
    expect(plan.outcomes[1]).toEqual({
      kind: "matched",
      existingId: "r",
      tier: 1,
    });
    expect(plan.outcomes[0].kind).toBe("withheld");
  });

  test("an item carrying NO marketplace id cannot claim a row by name", () => {
    const r = row("r", "Topps");
    const plan = planSelectorSync({ existing: [r], items: [item("Topps", {})] });
    // There is nothing to attach, so the match would be a no-op that
    // nonetheless claims the row — hiding it from an item that does carry its
    // id. Legitimately id-less rows are custom ones, and those arrive through
    // addCustomSelectorOption, not through a store.
    expect(plan.outcomes[0]).toEqual({
      kind: "withheld",
      reason: "item carries no marketplace id to attach",
    });
  });

  test("an id-less item that matches no name still inserts", () => {
    const plan = planSelectorSync({
      existing: [row("r", "Topps")],
      items: [item("Bowman", {})],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "insert" });
  });

  test("a per-side ambiguity is reported even when the other side resolves", () => {
    const a = row("a", "Shared", {
      platformData: { bsc: { b0: "dupe" }, sportlots: { s0: "sl-a" } },
    });
    const b = row("b", "Also Shared", { platformData: { bsc: { b0: "dupe" } } });
    const plan = planSelectorSync({
      existing: [a, b],
      items: [item("Shared", { bsc: "dupe", sportlots: "sl-a" })],
    });
    // SportLots resolves cleanly to A, so the item matches — but the BSC id
    // sitting on two rows is worth knowing about either way, and used to be
    // dropped on the floor whenever the other side saved the match.
    expect(plan.outcomes[0]).toMatchObject({ kind: "matched", existingId: "a" });
    expect(plan.ambiguities).toHaveLength(1);
    expect(plan.ambiguities[0].reason).toContain("held by 2 sibling rows");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// NEO-237 — placeholder links: a hand-typed brand born holding SportLots'
// all-brands option id, before Sync Manufacturers ever listed the brand.
// ───────────────────────────────────────────────────────────────────────────

describe("planSelectorSync — placeholder links (NEO-237)", () => {
  /** What `storeSelectorOptions` passes at manufacturer level. */
  const slPlaceholder = (side: string, id: string) =>
    side === "sportlots" && isSlAllBrandsBrandId(id);

  /** A brand typed on the New Manufacturer step: the slot `addCustomSelectorOption` writes. */
  const viaAllBrands = (id: string, value: string) =>
    row(id, value, {
      level: "manufacturer",
      platformData: { sportlots: { s0: SL_ALL_BRANDS_BRAND_ID } },
      platformLabels: { sportlots: { s0: value } },
      platformSlotSeq: { sportlots: 1 },
    });

  /** The fetch always returns the all-brands option beside the real brands. */
  const returned = (...real: string[]) => ({
    sportlots: [...real, SL_ALL_BRANDS_BRAND_ID],
  });

  test("a hand-typed brand holding the placeholder is FREE for its real id, and the outcome says so", () => {
    const topps = viaAllBrands("a", "Topps");
    const plan = planSelectorSync({
      existing: [topps],
      items: [item("Topps", { sportlots: "1" })],
      coveredSides: ["sportlots"],
      returnedIds: returned("1"),
      isPlaceholderId: slPlaceholder,
    });
    // Tier 2, and the plan names the side whose placeholder the real id
    // replaces — the store counts it as an upgrade, not a `relinked` re-slug.
    expect(plan.outcomes[0]).toEqual({
      kind: "matched",
      existingId: "a",
      tier: 2,
      placeholderSides: ["sportlots"],
    });
    expect(plan.ambiguities).toEqual([]);
  });

  test("without the predicate the placeholder is a live id — today's withhold, unchanged (the reconciler path)", () => {
    const topps = viaAllBrands("a", "Topps");
    const plan = planSelectorSync({
      existing: [topps],
      items: [item("Topps", { sportlots: "1" })],
      coveredSides: ["sportlots"],
      returnedIds: returned("1"),
    });
    // The gap this ticket closes, pinned as the behaviour a caller that
    // names no placeholder still gets: the sentinel came back in
    // `returnedIds`, so the row reads as bound to a live id.
    expect(plan.outcomes[0]).toEqual({
      kind: "withheld",
      reason: "name matches a row already linked to a different live id",
    });
  });

  test("a row holding a REAL SportLots brand id keeps today's withhold", () => {
    const topps = row("a", "Topps", {
      level: "manufacturer",
      platformData: { sportlots: { s0: "1" } },
      platformSlotSeq: { sportlots: 1 },
    });
    const plan = planSelectorSync({
      existing: [topps],
      items: [
        item("Topps", { sportlots: "1" }), // keeps "1" alive
        item("Topps", { sportlots: "2" }), // same name, different brand id
      ],
      coveredSides: ["sportlots"],
      returnedIds: returned("1", "2"),
      isPlaceholderId: slPlaceholder,
    });
    expect(plan.outcomes[0]).toEqual({ kind: "matched", existingId: "a", tier: 1 });
    expect(plan.outcomes[1]).toEqual({
      kind: "withheld",
      reason: "name matches a row already linked to a different live id",
    });
  });

  test("two placeholder rows folding to the incoming name are withheld — never a coin flip", () => {
    const plan = planSelectorSync({
      existing: [viaAllBrands("a", "Topps"), viaAllBrands("b", "TOPPS")],
      items: [item("Topps", { sportlots: "1" })],
      coveredSides: ["sportlots"],
      returnedIds: returned("1"),
      isPlaceholderId: slPlaceholder,
    });
    expect(plan.outcomes[0].kind).toBe("withheld");
    expect(plan.ambiguities[0].reason).toContain("share this name");
  });

  test("a via-All-Brands brand the fetch does not list keeps its placeholder through the unlink pass", () => {
    const bandai = viaAllBrands("b", "Bandai");
    const plan = planSelectorSync({
      existing: [viaAllBrands("a", "Topps"), bandai],
      items: [item("Topps", { sportlots: "1" })],
      coveredSides: ["sportlots"],
      returnedIds: returned("1"),
      isPlaceholderId: slPlaceholder,
    });
    // Nothing named Bandai came in, so Bandai is nobody's match…
    expect(plan.outcomes).toEqual([
      { kind: "matched", existingId: "a", tier: 2, placeholderSides: ["sportlots"] },
    ]);
    // …and the sentinel is still in the returned universe (D6 keeps it
    // there), so the unlink pass leaves the placeholder on every holder the
    // sync did not upgrade. Freeing the side for a NAME match must not make
    // the id look delisted.
    expect(plan.coveredSides).toEqual(["sportlots"]);
    expect(plan.returnedIds.sportlots.has(SL_ALL_BRANDS_BRAND_ID)).toBe(true);
    expect(
      unlinkStalePrimary(bandai, "sportlots", plan.returnedIds.sportlots),
    ).toBeUndefined();
  });

  test("placeholder freeness is judged only on the sides the item carries", () => {
    // BSC lists Topps; SportLots does not (yet). The BSC id attaches by name
    // and the SportLots placeholder is simply not in play — no
    // `placeholderSides`, because nothing on that side is being replaced.
    const topps = viaAllBrands("a", "Topps");
    const plan = planSelectorSync({
      existing: [topps],
      items: [item("Topps", { bsc: "topps-1997" })],
      coveredSides: ["bsc", "sportlots"],
      returnedIds: { bsc: ["topps-1997"], ...returned() },
      isPlaceholderId: slPlaceholder,
    });
    expect(plan.outcomes[0]).toEqual({ kind: "matched", existingId: "a", tier: 2 });
  });

  test("tier 1 is untouched: an item carrying the placeholder id itself is still M:1-withheld", () => {
    // D6 routes the option out before the plan; this pins what happens if an
    // old bundle ever sent it anyway — the id sits on two rows, so it is not
    // evidence of which one the update belongs to, predicate or no predicate.
    const plan = planSelectorSync({
      existing: [viaAllBrands("a", "Topps"), viaAllBrands("b", "Bandai")],
      items: [item("All Brands", { sportlots: SL_ALL_BRANDS_BRAND_ID })],
      coveredSides: ["sportlots"],
      returnedIds: returned(),
      isPlaceholderId: slPlaceholder,
    });
    expect(plan.outcomes[0]).toEqual({
      kind: "withheld",
      reason: "sportlots id is held by 2 sibling rows",
    });
  });
});

describe("planSelectorSync — a row held elsewhere in the variant type's subtree (NEO-300)", () => {
  // The shape the bug produced: Sync Inserts stored Chrome and Refractor as
  // sibling inserts, the operator grouped Refractor under Chrome as a
  // parallel, and the next Sync Inserts saw only Chrome among its siblings.
  const chrome = () =>
    row("chrome", "Chrome", { platformData: { bsc: { b0: "chrome-v" } } });
  const refractorParallel = () =>
    row("refractor", "Refractor", {
      level: "parallel",
      platformData: { bsc: { b0: "refractor-v" }, sportlots: { s0: "sl-ref" } },
    });

  test("an id no sibling holds but a subtree row does is heldElsewhere, not an insert", () => {
    const plan = planSelectorSync({
      existing: [chrome()],
      items: [
        item("Chrome", { bsc: "chrome-v" }),
        item("Refractor", { bsc: "refractor-v" }),
      ],
      elsewhereInSubtree: [refractorParallel()],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "matched", existingId: "chrome", tier: 1 });
    expect(plan.outcomes[1]).toEqual({ kind: "heldElsewhere", rowId: "refractor", tier: 1 });
  });

  test("today's rule without the subtree: the same item is an insert (the bug)", () => {
    const plan = planSelectorSync({
      existing: [chrome()],
      items: [item("Refractor", { bsc: "refractor-v" })],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "insert" });
  });

  test("either side's id identifies the held row", () => {
    const plan = planSelectorSync({
      existing: [chrome()],
      items: [item("Refractors (SL)", { sportlots: "sl-ref" })],
      elsewhereInSubtree: [refractorParallel()],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "heldElsewhere", rowId: "refractor", tier: 1 });
  });

  test("a sibling holding the id still wins over a subtree row holding it too", () => {
    const siblingCopy = row("sib", "Refractor", {
      platformData: { bsc: { b0: "refractor-v" } },
    });
    const plan = planSelectorSync({
      existing: [chrome(), siblingCopy],
      items: [item("Refractor", { bsc: "refractor-v" })],
      elsewhereInSubtree: [refractorParallel()],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "matched", existingId: "sib", tier: 1 });
  });

  test("a sibling holding ONE of the item's ids wins, even if the other is held elsewhere", () => {
    const sib = row("sib", "Refractor", { platformData: { bsc: { b0: "refractor-v" } } });
    const plan = planSelectorSync({
      existing: [sib],
      items: [item("Refractor", { bsc: "refractor-v", sportlots: "sl-ref" })],
      elsewhereInSubtree: [refractorParallel()],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "matched", existingId: "sib", tier: 1 });
  });

  test("the modal's existingId naming a subtree row is heldElsewhere at tier 0", () => {
    const plan = planSelectorSync({
      existing: [chrome()],
      items: [item("Refractor", {}, "refractor")],
      elsewhereInSubtree: [refractorParallel()],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "heldElsewhere", rowId: "refractor", tier: 0 });
  });

  test("never by name: a same-named subtree row with no shared id does not hold the item", () => {
    const plan = planSelectorSync({
      existing: [chrome()],
      items: [item("Refractor", { bsc: "a-different-set" })],
      elsewhereInSubtree: [refractorParallel()],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "insert" });
  });

  test("an id held by two subtree rows is WITHHELD, not inserted and not guessed", () => {
    const twin = row("twin", "Refractor B", {
      level: "parallel",
      platformData: { bsc: { b0: "refractor-v" } },
    });
    const plan = planSelectorSync({
      existing: [chrome()],
      items: [item("Refractor", { bsc: "refractor-v" })],
      elsewhereInSubtree: [refractorParallel(), twin],
    });
    expect(plan.outcomes[0]).toEqual({
      kind: "withheld",
      reason: "marketplace ids are held by 2 rows elsewhere in this variant type",
      // Named, so the store can tell the operator which rows (audit finding 6).
      elsewhere: { reason: "heldByMany", holderIds: ["refractor", "twin"] },
    });
    expect(plan.ambiguities).toHaveLength(1);
  });

  test("tier 0 needs the ids to agree: an existingId whose row lacks the item's id is WITHHELD and names the row", () => {
    const plan = planSelectorSync({
      existing: [chrome()],
      // The modal says "this is Refractor", but carries a BSC id Refractor
      // does not hold.
      items: [item("Refractor", { bsc: "some-other-set" }, "refractor")],
      elsewhereInSubtree: [refractorParallel()],
    });
    expect(plan.outcomes[0]).toEqual({
      kind: "withheld",
      reason:
        "existingId names a row elsewhere in this variant type that does not hold the item's bsc id",
      elsewhere: { reason: "idsDisagree", holderIds: ["refractor"] },
    });
  });

  test("tier 0 with ids the row DOES hold is heldElsewhere", () => {
    const plan = planSelectorSync({
      existing: [chrome()],
      items: [item("Refractor", { bsc: "refractor-v", sportlots: "sl-ref" }, "refractor")],
      elsewhereInSubtree: [refractorParallel()],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "heldElsewhere", rowId: "refractor", tier: 0 });
  });

  test("tier 0: one agreeing side does not excuse a disagreeing one", () => {
    const plan = planSelectorSync({
      existing: [chrome()],
      items: [item("Refractor", { bsc: "refractor-v", sportlots: "sl-other" }, "refractor")],
      elsewhereInSubtree: [refractorParallel()],
    });
    expect(plan.outcomes[0].kind).toBe("withheld");
  });

  test("a sibling-level withhold carries no `elsewhere` — its shape is unchanged", () => {
    const a = row("a", "Series 1", { platformData: { bsc: { b0: "x" } } });
    const b = row("b", "Series 2", { platformData: { bsc: { b0: "x" } } });
    const plan = planSelectorSync({
      existing: [a, b],
      items: [item("Anything", { bsc: "x" })],
      elsewhereInSubtree: [refractorParallel()],
    });
    expect(plan.outcomes[0]).toEqual({
      kind: "withheld",
      reason: "bsc id is held by 2 sibling rows",
    });
  });

  test("a subtree row that is also a sibling is treated as a sibling only", () => {
    const sib = row("sib", "Refractor", { platformData: { bsc: { b0: "refractor-v" } } });
    const plan = planSelectorSync({
      existing: [sib],
      items: [item("Refractor", { bsc: "refractor-v" })],
      elsewhereInSubtree: [sib],
    });
    expect(plan.outcomes[0]).toEqual({ kind: "matched", existingId: "sib", tier: 1 });
  });

  test("a sibling-level ambiguity stays a withhold — the subtree cannot turn it into a hit", () => {
    const a = row("a", "Series 1", { platformData: { bsc: { b0: "refractor-v" } } });
    const b = row("b", "Series 2", { platformData: { bsc: { b0: "refractor-v" } } });
    const plan = planSelectorSync({
      existing: [a, b],
      items: [item("Refractor", { bsc: "refractor-v" })],
      elsewhereInSubtree: [refractorParallel()],
    });
    expect(plan.outcomes[0].kind).toBe("withheld");
  });
});

describe("itemsReachPastSiblings (NEO-300)", () => {
  const sib = row("sib", "Chrome", { platformData: { bsc: { b0: "chrome-v" } } });

  test("false when every id and existingId is already on a sibling — the subtree read is skipped", () => {
    expect(
      itemsReachPastSiblings([sib], [item("Chrome", { bsc: "chrome-v" }, "sib")]),
    ).toBe(false);
  });

  test("true for an id no sibling holds", () => {
    expect(itemsReachPastSiblings([sib], [item("Refractor", { bsc: "refractor-v" })])).toBe(true);
  });

  test("true for an existingId that is not a sibling", () => {
    expect(itemsReachPastSiblings([sib], [item("Refractor", {}, "elsewhere")])).toBe(true);
  });

  test("false for an item with no ids at all — nothing it could be held by", () => {
    expect(itemsReachPastSiblings([sib], [item("Nameless")])).toBe(false);
  });
});

describe("indistinguishableByMarketplaceIds (NEO-300)", () => {
  const r = (platformData: Row["platformData"], value = "X") =>
    row(value, value, { platformData });

  test("the same id on the one side both are linked on: indistinguishable", () => {
    expect(
      indistinguishableByMarketplaceIds(
        r({ bsc: { b0: "p", b1: "q" } }),
        r({ bsc: { b3: "q" } }),
      ),
    ).toBe(true);
  });

  test("the same ids on both sides: indistinguishable", () => {
    expect(
      indistinguishableByMarketplaceIds(
        r({ bsc: { b0: "p" }, sportlots: { s0: "s1" } }),
        r({ bsc: { b0: "p" }, sportlots: { s0: "s1" } }),
      ),
    ).toBe(true);
  });

  test("NEO-137 M:1 — one SportLots set over two rows BSC splits: DISTINGUISHABLE", () => {
    expect(
      indistinguishableByMarketplaceIds(
        r({ bsc: { b0: "refractor" }, sportlots: { s0: "sl-set" } }),
        r({ bsc: { b0: "gold-refractor" }, sportlots: { s0: "sl-set" } }),
      ),
    ).toBe(false);
  });

  test("a side only one row is linked on says nothing: the common side decides", () => {
    expect(
      indistinguishableByMarketplaceIds(
        r({ sportlots: { s0: "sl-set" } }),
        r({ bsc: { b0: "p" }, sportlots: { s0: "sl-set" } }),
      ),
    ).toBe(true);
  });

  test("the same string on DIFFERENT sides: no common side, not indistinguishable", () => {
    expect(
      indistinguishableByMarketplaceIds(
        r({ bsc: { b0: "q" } }),
        r({ sportlots: { s0: "q" } }),
      ),
    ).toBe(false);
  });

  test("a row with no links is never indistinguishable, whatever its name", () => {
    expect(
      indistinguishableByMarketplaceIds(r({}, "Refractor"), r({}, "Refractor")),
    ).toBe(false);
    expect(
      indistinguishableByMarketplaceIds(r({ bsc: { b0: "p" } }, "Refractor"), r({}, "Refractor")),
    ).toBe(false);
  });
});

describe("unlinkStalePrimary", () => {
  const withExtras = row("a", "Base", {
    platformData: { bsc: { b0: "primary-gone", b1: "extra-gone" } },
    platformLabels: { bsc: { b0: "Primary", b1: "Extra" } },
    platformFacets: { bsc: { b0: "variantName", b1: "setName" } },
    primaryPlatformId: { bsc: "b0" },
    platformSlotSeq: { bsc: 2 },
  });

  test("detaches the PRIMARY slot only — operator extras and facets survive", () => {
    // The extra's id is missing upstream too, and it still stays: an extra is
    // often an id from a DIFFERENT BSC facet than this level's fetch queries
    // (NEO-189), so "this fetch did not mention it" is no evidence at all.
    const out = unlinkStalePrimary(withExtras, "bsc", new Set());
    expect(out).toBeTruthy();
    expect(out!.id).toBe("primary-gone");
    expect(out!.platformData.bsc).toEqual({ b1: "extra-gone" });
    expect(out!.platformLabels.bsc).toEqual({ b1: "Extra" });
    expect(out!.platformFacets.bsc).toEqual({ b1: "setName" });
    expect(out!.primaryPlatformId?.bsc).toBeUndefined();
  });

  test("does nothing when the primary's id DID come back", () => {
    expect(
      unlinkStalePrimary(withExtras, "bsc", new Set(["primary-gone"])),
    ).toBeUndefined();
  });

  test("does nothing on a side with no slots", () => {
    expect(unlinkStalePrimary(withExtras, "sportlots", new Set())).toBeUndefined();
  });
});

describe("checkSelectorValue", () => {
  test("rejects empty, over-long and control-character names", () => {
    expect(checkSelectorValue("   ").ok).toBe(false);
    expect(checkSelectorValue("x".repeat(300)).ok).toBe(false);
    expect(checkSelectorValue("Topps\nSeries 1").ok).toBe(false);
    expect(checkSelectorValue("Topps\u007F").ok).toBe(false);
  });

  test("accepts and trims a normal name", () => {
    expect(checkSelectorValue("  Topps Series 1 ")).toEqual({
      ok: true,
      value: "Topps Series 1",
    });
  });

  test("the exact boundary: 200 chars allowed, 201 refused", () => {
    expect(checkSelectorValue("x".repeat(200))).toEqual({
      ok: true,
      value: "x".repeat(200),
    });
    expect(checkSelectorValue("x".repeat(201))).toMatchObject({ ok: false });
  });

  test("a tab is rejected as a control character", () => {
    expect(checkSelectorValue("Topps\tSeries 1").ok).toBe(false);
  });

  test("a zero-width space is rejected", () => {
    // ZERO WIDTH SPACE (U+200B) is outside the ASCII control range and is not
    // Unicode White_Space, so `.trim()` leaves it in place — which makes it
    // strictly worse than a control code here. Nothing RENDERS it, so a label
    // carrying one is visually identical to one without, yet it is a different
    // string, folds to a different `selectorValueKey`, and slips past the
    // sibling-clash check to leave two rows no operator can tell apart.
    const withZeroWidth = "\u200BTopps";
    expect(checkSelectorValue(withZeroWidth)).toEqual({
      ok: false,
      reason: "Name cannot contain zero-width or invisible characters",
    });
  });

  test("the other invisible codepoints are rejected too", () => {
    // ZWNJ, ZWJ, WORD JOINER and the BOM all reach a display value the same
    // way — a marketplace label, or a copy-paste out of a rich-text editor.
    for (const ch of ["\u200C", "\u200D", "\u2060", "\uFEFF"]) {
      expect(checkSelectorValue(`Topps${ch}Chrome`).ok).toBe(false);
    }
  });
});

describe("planValueRename", () => {
  test("allows ANY variantType rename — the refusal is gone (NEO-239)", () => {
    // NEO-211 F refused a rename on a variantType row the sync had created,
    // because two things read that row's DISPLAY VALUE as data: the BSC
    // checklist fetch derived its `variant` facet from it, and "which row is
    // the base set" was the literal string "base". Both now read the row — a
    // `variant`-tagged BSC slot and `metadata.isBase` — so the name is a name.
    //
    // Renaming a variantType was the one thing an operator could not do to
    // their own taxonomy, and the reason was always an adapter's shortcut.
    const plan = planValueRename({
      row: { _id: "a", level: "variantType", value: "Base", metadata: undefined },
      nextValue: "Base Set",
      siblings: [],
    });
    expect(plan).toMatchObject({ ok: true, unchanged: false, value: "Base Set" });
  });

  test("a variantType rename still obeys the sibling-clash rule", () => {
    // Dropping the blanket refusal does not drop the guard that matters: two
    // rows under one parent must not share a display value, or the drill utils
    // and pickers cannot tell them apart.
    const plan = planValueRename({
      row: { _id: "a", level: "variantType", value: "Base", metadata: undefined },
      nextValue: "insert",
      siblings: [
        { _id: "a", value: "Base" },
        { _id: "b", value: "Insert" },
      ],
    });
    expect(plan).toMatchObject({ ok: false, reason: "clash" });
  });

  test("refuses a sibling clash on the folded name", () => {
    const plan = planValueRename({
      row: { _id: "a", level: "setName", value: "Topps", metadata: undefined },
      nextValue: "bowman",
      siblings: [
        { _id: "a", value: "Topps" },
        { _id: "b", value: "Bowman" },
      ],
    });
    expect(plan).toMatchObject({ ok: false, reason: "clash" });
  });

  test("reports an identical name as unchanged rather than a write", () => {
    const plan = planValueRename({
      row: { _id: "a", level: "setName", value: "Topps", metadata: undefined },
      nextValue: "  Topps  ",
      siblings: [{ _id: "a", value: "Topps" }],
    });
    expect(plan).toEqual({ ok: true, unchanged: true });
  });

  test("rejects an over-long or control-character label without throwing", () => {
    expect(
      planValueRename({
        row: { _id: "a", level: "setName", value: "Topps", metadata: undefined },
        nextValue: "x".repeat(300),
        siblings: [],
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      planValueRename({
        row: { _id: "a", level: "setName", value: "Topps", metadata: undefined },
        nextValue: "Top\nps",
        siblings: [],
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
  });

  // ── NEO-294: the year's Unknown row does not rename ──────────────────────

  test("refuses a rename of the year's brand-unknown row", () => {
    // Jason, 2026-09-22: "Unknown should not be renamable." Every other
    // brand-unknown consumer finds the row by its NB ROLE, so the refusal
    // reads the flag too — never the name.
    const plan = planValueRename({
      row: {
        _id: "u",
        level: "manufacturer",
        value: "Unknown",
        metadata: { isBrandUnknown: true },
      },
      nextValue: "Choice",
      siblings: [{ _id: "u", value: "Unknown" }],
    });
    expect(plan).toEqual({
      ok: false,
      reason: "invalid",
      message: BRAND_UNKNOWN_RENAME_REFUSAL,
    });
  });

  test("refuses a flagged row still wearing the legacy 'All Brands' name", () => {
    // The row NB has not renamed yet is the same row. A refusal keyed on the
    // name "Unknown" would let this one through — which is exactly the state
    // `ensureBrandRowForName` has to report as `id: null`.
    const plan = planValueRename({
      row: {
        _id: "u",
        level: "manufacturer",
        value: "All Brands",
        metadata: { isBrandUnknown: true },
      },
      nextValue: "Star",
      siblings: [],
    });
    expect(plan).toMatchObject({
      ok: false,
      message: BRAND_UNKNOWN_RENAME_REFUSAL,
    });
  });

  test("refuses even a no-op rename of the flagged row", () => {
    // "Can I rename this row" must not depend on what was typed: a no-op that
    // answers `unchanged: true` tells a caller the door is open.
    const plan = planValueRename({
      row: {
        _id: "u",
        level: "manufacturer",
        value: "Unknown",
        metadata: { isBrandUnknown: true },
      },
      nextValue: "Unknown",
      siblings: [{ _id: "u", value: "Unknown" }],
    });
    expect(plan).toMatchObject({ ok: false, reason: "invalid" });
  });

  test("an explicit isBrandUnknown: false is a real brand and renames", () => {
    // NEO-237's `markBrandUnknownRole` treats `false` as an operator saying
    // "this IS a brand" and never overrules it. The rename door agrees.
    const plan = planValueRename({
      row: {
        _id: "m",
        level: "manufacturer",
        value: "Choice",
        metadata: { isBrandUnknown: false },
      },
      nextValue: "Choice Marketing",
      siblings: [],
    });
    expect(plan).toMatchObject({ ok: true, unchanged: false, value: "Choice Marketing" });
  });

  test("an ordinary brand row with no metadata renames as before", () => {
    const plan = planValueRename({
      row: {
        _id: "m",
        level: "manufacturer",
        value: "Topps",
        metadata: undefined,
      },
      nextValue: "Topps Company",
      siblings: [],
    });
    expect(plan).toMatchObject({ ok: true, unchanged: false, value: "Topps Company" });
  });

  test("the internal escape hatch lets the backfill rename the flagged row", () => {
    // `backfillBrandPrefixAndUnknownName` renames the legacy "All Brands"
    // bucket to "Unknown". NB retiring its own word on its own row is the
    // opposite of the case the refusal exists to stop, so it opts out — and
    // nothing an operator or a marketplace label can reach sets this.
    const plan = planValueRename({
      row: {
        _id: "u",
        level: "manufacturer",
        value: "All Brands",
        metadata: { isBrandUnknown: true },
      },
      nextValue: "Unknown",
      siblings: [{ _id: "u", value: "All Brands" }],
      allowBrandUnknownRename: true,
    });
    expect(plan).toMatchObject({ ok: true, unchanged: false, value: "Unknown" });
  });

  test("the escape hatch does not also lift the sibling-clash rule", () => {
    // It opens ONE door. A year that somehow holds both a flagged row and a
    // row already called "Unknown" must still not end up with two.
    const plan = planValueRename({
      row: {
        _id: "u",
        level: "manufacturer",
        value: "All Brands",
        metadata: { isBrandUnknown: true },
      },
      nextValue: "Unknown",
      siblings: [
        { _id: "u", value: "All Brands" },
        { _id: "x", value: "unknown" },
      ],
      allowBrandUnknownRename: true,
    });
    expect(plan).toMatchObject({ ok: false, reason: "clash" });
  });
});

describe("isBrandUnknownRow", () => {
  test("reads the flag, and only `true` counts", () => {
    expect(isBrandUnknownRow({ isBrandUnknown: true })).toBe(true);
    expect(isBrandUnknownRow({ isBrandUnknown: false })).toBe(false);
    expect(isBrandUnknownRow({})).toBe(false);
    expect(isBrandUnknownRow(undefined)).toBe(false);
    expect(isBrandUnknownRow(null)).toBe(false);
  });
});

describe("clearDeclinedIfLabelChanged", () => {
  test("keeps the decline while the label is the same (fold-insensitively)", () => {
    const out = clearDeclinedIfLabelChanged({ bsc: "topps" }, "bsc", "TOPPS");
    expect(out.changed).toBe(false);
  });

  test("drops the decline the moment the label becomes something new", () => {
    const out = clearDeclinedIfLabelChanged({ bsc: "topps" }, "bsc", "Bowman");
    expect(out).toEqual({ changed: true, next: undefined });
  });

  test("leaves the other side alone", () => {
    const out = clearDeclinedIfLabelChanged(
      { bsc: "topps", sportlots: "tpps" },
      "bsc",
      "Bowman",
    );
    expect(out.next).toEqual({ sportlots: "tpps" });
  });
});
