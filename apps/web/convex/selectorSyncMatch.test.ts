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
  checkSelectorValue,
  clearDeclinedIfLabelChanged,
  effectiveCoveredSides,
  planSelectorSync,
  planValueRename,
  selectorValueKey,
  unlinkStalePrimary,
  type IncomingItem,
  type MatchableRow,
} from "./selectorSyncMatch";

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

describe("effectiveCoveredSides", () => {
  const items = [item("A", { bsc: "b1" }), item("B", { sportlots: "s1" })];

  test("absent coveredSides covers NOTHING — silence is not evidence", () => {
    // The release-safety property: an old SPA bundle mid-deploy cannot say
    // "SportLots was down", so it says nothing, and nothing gets unlinked.
    expect(effectiveCoveredSides(items, undefined)).toEqual([]);
    expect(effectiveCoveredSides(items, [])).toEqual([]);
  });

  test("narrows a declared side that carried no id in this batch", () => {
    const bscOnly = [item("A", { bsc: "b1" })];
    expect(effectiveCoveredSides(bscOnly, ["bsc", "sportlots"])).toEqual([
      "bsc",
    ]);
  });

  test("declaring both with both present covers both", () => {
    expect(effectiveCoveredSides(items, ["bsc", "sportlots"])).toEqual([
      "bsc",
      "sportlots",
    ]);
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

  test("two items claiming one existingId: first matches, second inserts", () => {
    const plan = planSelectorSync({
      existing: [row("a", "Topps")],
      items: [item("Topps One", {}, "a"), item("Topps Two", {}, "a")],
    });
    expect(plan.outcomes[0]).toMatchObject({ kind: "matched", existingId: "a" });
    expect(plan.outcomes[1]).toEqual({ kind: "insert" });
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
});

describe("planValueRename", () => {
  test("refuses a non-custom variantType row", () => {
    const plan = planValueRename({
      row: { _id: "a", level: "variantType", value: "Base" },
      nextValue: "Base Set",
      siblings: [],
    });
    expect(plan).toMatchObject({ ok: false, reason: "refused" });
  });

  test("allows a CUSTOM variantType row", () => {
    const plan = planValueRename({
      row: { _id: "a", level: "variantType", value: "Base", isCustom: true },
      nextValue: "My Base",
      siblings: [{ _id: "a", value: "Base" }],
    });
    expect(plan).toMatchObject({ ok: true, unchanged: false, value: "My Base" });
  });

  test("refuses a sibling clash on the folded name", () => {
    const plan = planValueRename({
      row: { _id: "a", level: "setName", value: "Topps" },
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
      row: { _id: "a", level: "setName", value: "Topps" },
      nextValue: "  Topps  ",
      siblings: [{ _id: "a", value: "Topps" }],
    });
    expect(plan).toEqual({ ok: true, unchanged: true });
  });

  test("rejects an over-long or control-character label without throwing", () => {
    expect(
      planValueRename({
        row: { _id: "a", level: "setName", value: "Topps" },
        nextValue: "x".repeat(300),
        siblings: [],
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(
      planValueRename({
        row: { _id: "a", level: "setName", value: "Topps" },
        nextValue: "Top\nps",
        siblings: [],
      }),
    ).toMatchObject({ ok: false, reason: "invalid" });
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
