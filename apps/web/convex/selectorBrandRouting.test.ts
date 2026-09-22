/**
 * NEO-237 — the pure brand-routing helpers in `selectorSyncMatch.ts`: the one
 * shared prefix matcher (D4), the Sync Sets BSC router (D8/D9) and the
 * SportLots-only classifier (D11).
 *
 * Kept in its own file, beside `selectorSyncMatch.test.ts`, because these
 * functions are a self-contained NEO-237 concern (brand routing) layered on
 * top of the NEO-211 matching module that file already covers — mirrors the
 * `selectorSyncStatus.test.ts` / `selectorSyncSuggestions.test.ts` split next
 * to it.
 *
 * `matchesBrandPrefix`, `routeBscSets` and `routeSlSets` are also this
 * ticket's adversarial-pass targets: unicode/punctuation boundaries, two
 * brands whose prefixes both match, a holder whose parent was deleted, and
 * the root cap's stability across runs are asserted here rather than left to
 * the happy path.
 */

import { describe, expect, test } from "vitest";
import {
  ALL_BRANDS_VIEW_REFUSAL,
  isAllBrandsViewName,
  knownSetNameKeys,
  MAX_SL_SET_MEMBERS,
  MAX_SL_SETS_PER_SYNC,
  matchesBrandPrefix,
  routeBscSets,
  routeSlSets,
  stripMatchedBrandPrefix,
  type BrandRouteManufacturer,
  type BscSetHolder,
  type MarketplaceSetEntry,
} from "./selectorSyncMatch";

// ───────────────────────────────────────────────────────────────────────────
// matchesBrandPrefix / stripMatchedBrandPrefix (D4)
// ───────────────────────────────────────────────────────────────────────────

describe("matchesBrandPrefix", () => {
  test("matches the exact brand name", () => {
    expect(matchesBrandPrefix("Topps", "Topps")).toBe(true);
  });

  test("matches a whole-word continuation separated by a space", () => {
    expect(matchesBrandPrefix("Topps Chrome", "Topps")).toBe(true);
  });

  test("matches across a non-alphanumeric boundary (widened from the old space-only rule)", () => {
    expect(matchesBrandPrefix("Upper Deck-Exquisite", "Upper Deck")).toBe(
      true,
    );
    expect(matchesBrandPrefix("Choice-Biloxi", "Choice")).toBe(true);
    expect(matchesBrandPrefix("Choice/Biloxi", "Choice")).toBe(true);
    expect(matchesBrandPrefix("Choice (Biloxi)", "Choice")).toBe(true);
  });

  test("does NOT match when the next character continues the word", () => {
    // The exact regression `stripBrandPrefixForLabel` learned the hard way.
    expect(matchesBrandPrefix("Toppstown Retro", "Topps")).toBe(false);
    expect(matchesBrandPrefix("Choices", "Choice")).toBe(false);
  });

  test("a prefix longer than the label never matches", () => {
    expect(matchesBrandPrefix("Upper", "Upper Deck")).toBe(false);
    expect(matchesBrandPrefix("", "Topps")).toBe(false);
  });

  test("an empty or whitespace-only prefix matches nothing", () => {
    expect(matchesBrandPrefix("Topps Chrome", "")).toBe(false);
    expect(matchesBrandPrefix("Topps Chrome", "   ")).toBe(false);
    // Not even an empty label against an empty prefix — empty means "buckets
    // nothing", not "matches everything".
    expect(matchesBrandPrefix("", "")).toBe(false);
  });

  test("folds case and surrounding whitespace on both sides", () => {
    expect(matchesBrandPrefix("  TOPPS chrome ", " topps ")).toBe(true);
  });

  test("an accented continuation is a longer word, not a boundary", () => {
    // "é" counts as alphanumeric under \p{L}, so "Topp" + "é" is not a
    // boundary even though it is not ASCII.
    expect(matchesBrandPrefix("Toppé Chrome", "Topp")).toBe(false);
  });

  test("a digit immediately after the prefix is not a boundary", () => {
    expect(matchesBrandPrefix("Topps2 Chrome", "Topps")).toBe(false);
  });

  test("punctuation-only labels do not crash and do not match by accident", () => {
    expect(matchesBrandPrefix("---", "Topps")).toBe(false);
    expect(matchesBrandPrefix("Topps", "---")).toBe(false);
  });
});

describe("stripMatchedBrandPrefix", () => {
  test("removes the matched prefix and trims", () => {
    expect(stripMatchedBrandPrefix("Topps Chrome", "Topps")).toBe("Chrome");
  });

  test("returns the label unchanged when the prefix does not match", () => {
    expect(stripMatchedBrandPrefix("Panini Prizm", "Topps")).toBe(
      "Panini Prizm",
    );
  });

  test("never strips a label down to nothing — a set named exactly after its brand keeps its name", () => {
    expect(stripMatchedBrandPrefix("Topps", "Topps")).toBe("Topps");
    expect(stripMatchedBrandPrefix(" Topps ", "Topps")).toBe("Topps");
  });

  test("strips a dash-like joining separator along with surrounding whitespace", () => {
    expect(stripMatchedBrandPrefix("Choice-Biloxi", "Choice")).toBe("Biloxi");
    expect(stripMatchedBrandPrefix("Choice – Biloxi", "Choice")).toBe(
      "Biloxi",
    );
    expect(stripMatchedBrandPrefix("Choice: Biloxi", "Choice")).toBe(
      "Biloxi",
    );
    expect(stripMatchedBrandPrefix("Choice/Biloxi", "Choice")).toBe("Biloxi");
    expect(stripMatchedBrandPrefix("Choice|Biloxi", "Choice")).toBe("Biloxi");
  });

  test("a non-dash boundary character is kept — it may be part of the set's name", () => {
    // "#", "(" and a quote are not joining punctuation; guessing they mean
    // nothing would be exactly the marketplace-name inference this module
    // exists to avoid.
    expect(stripMatchedBrandPrefix("Choice#7", "Choice")).toBe("#7");
    expect(stripMatchedBrandPrefix("Choice (Biloxi)", "Choice")).toBe(
      "(Biloxi)",
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// isAllBrandsViewName / ALL_BRANDS_VIEW_REFUSAL
// ───────────────────────────────────────────────────────────────────────────

describe("isAllBrandsViewName", () => {
  test("recognises the view name folded through case and whitespace", () => {
    expect(isAllBrandsViewName("All Brands")).toBe(true);
    expect(isAllBrandsViewName("  all brands ")).toBe(true);
    expect(isAllBrandsViewName("ALL BRANDS")).toBe(true);
  });

  test("does not match a real brand name that merely contains the words", () => {
    expect(isAllBrandsViewName("All Brands Wax Pack Co")).toBe(false);
    expect(isAllBrandsViewName("Topps")).toBe(false);
    expect(isAllBrandsViewName("Unknown")).toBe(false);
  });

  test("the refusal text names the view, not a marketplace value", () => {
    expect(ALL_BRANDS_VIEW_REFUSAL).toMatch(/view at the top of this column/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// routeBscSets (D8/D9)
// ───────────────────────────────────────────────────────────────────────────

type Id = string;

function mfr(
  id: Id,
  opts: { prefix?: string; unknown?: boolean } = {},
): BrandRouteManufacturer<Id> {
  return {
    _id: id,
    ...(opts.prefix !== undefined ? { setNamePrefix: opts.prefix } : {}),
    ...(opts.unknown !== undefined ? { isBrandUnknown: opts.unknown } : {}),
  };
}

function set(value: string, platformValue: string): MarketplaceSetEntry {
  return { value, platformValue };
}

function holder(rowId: Id, parentId: Id): BscSetHolder<Id> {
  return { rowId, parentId };
}

describe("routeBscSets", () => {
  test("no holder, no matching prefix → Unknown", () => {
    const plan = routeBscSets({
      sets: [set("Bowman Chrome", "bsc-1")],
      manufacturers: [mfr("topps", { prefix: "Topps" }), mfr("unk", { unknown: true })],
      holdersByBscId: new Map(),
    });
    expect(plan.unknown).toEqual([set("Bowman Chrome", "bsc-1")]);
    expect(plan.buckets.size).toBe(0);
    expect(plan.moves).toEqual([]);
  });

  test("no holder, prefix match → that brand's bucket", () => {
    const plan = routeBscSets({
      sets: [set("Topps Chrome", "bsc-1")],
      manufacturers: [mfr("topps", { prefix: "Topps" })],
      holdersByBscId: new Map(),
    });
    expect(plan.buckets.get("topps")).toEqual([set("Topps Chrome", "bsc-1")]);
    expect(plan.unknown).toEqual([]);
  });

  test("the LONGEST matching prefix wins ('Upper Deck' before 'Upper')", () => {
    const plan = routeBscSets({
      sets: [set("Upper Deck Exquisite", "bsc-1")],
      manufacturers: [
        mfr("upper", { prefix: "Upper" }),
        mfr("upperDeck", { prefix: "Upper Deck" }),
      ],
      holdersByBscId: new Map(),
    });
    expect(plan.buckets.get("upperDeck")).toEqual([
      set("Upper Deck Exquisite", "bsc-1"),
    ]);
    expect(plan.buckets.has("upper")).toBe(false);
  });

  test("id under a brand beats prefix, even when the label would match a DIFFERENT brand's prefix", () => {
    // Placement is linkage; the name is not consulted once a holder exists
    // under a brand.
    const plan = routeBscSets({
      sets: [set("Panini Prizm", "bsc-1")],
      manufacturers: [
        mfr("topps", { prefix: "Topps" }),
        mfr("panini", { prefix: "Panini" }),
      ],
      holdersByBscId: new Map([
        ["bsc-1", [holder("row-1", "topps")]],
      ]),
    });
    expect(plan.buckets.get("topps")).toEqual([set("Panini Prizm", "bsc-1")]);
    expect(plan.buckets.has("panini")).toBe(false);
    expect(plan.moves).toEqual([]);
  });

  test("id under Unknown + label prefix-matches a brand → re-home and bucket under the brand", () => {
    const plan = routeBscSets({
      sets: [set("Topps Chrome", "bsc-1")],
      manufacturers: [mfr("topps", { prefix: "Topps" }), mfr("unk", { unknown: true })],
      holdersByBscId: new Map([["bsc-1", [holder("row-1", "unk")]]]),
    });
    expect(plan.buckets.get("topps")).toEqual([set("Topps Chrome", "bsc-1")]);
    expect(plan.moves).toEqual([
      { rowId: "row-1", fromId: "unk", toId: "topps" },
    ]);
  });

  test("id under Unknown + no matching prefix → stays in Unknown, in place (no move)", () => {
    const plan = routeBscSets({
      sets: [set("Some Odd Set", "bsc-1")],
      manufacturers: [mfr("topps", { prefix: "Topps" }), mfr("unk", { unknown: true })],
      holdersByBscId: new Map([["bsc-1", [holder("row-1", "unk")]]]),
    });
    expect(plan.unknown).toEqual([set("Some Odd Set", "bsc-1")]);
    expect(plan.moves).toEqual([]);
    expect(plan.buckets.size).toBe(0);
  });

  test("a flagged row is never a prefix candidate, even if it carries a setNamePrefix", () => {
    const plan = routeBscSets({
      sets: [set("Topps Chrome", "bsc-1")],
      manufacturers: [mfr("unk", { unknown: true, prefix: "Topps" })],
      holdersByBscId: new Map(),
    });
    expect(plan.unknown).toEqual([set("Topps Chrome", "bsc-1")]);
  });

  test("a row lacking setNamePrefix buckets nothing by prefix", () => {
    const plan = routeBscSets({
      sets: [set("Topps Chrome", "bsc-1")],
      manufacturers: [mfr("topps")],
      holdersByBscId: new Map(),
    });
    expect(plan.unknown).toEqual([set("Topps Chrome", "bsc-1")]);
    expect(plan.buckets.size).toBe(0);
  });

  test("several holders under brands (NEO-137 M:1) → the first brand holder's bucket, nothing moves", () => {
    const plan = routeBscSets({
      sets: [set("Shared Set", "bsc-1")],
      manufacturers: [mfr("topps", { prefix: "Topps" }), mfr("panini", { prefix: "Panini" })],
      holdersByBscId: new Map([
        ["bsc-1", [holder("row-topps", "topps"), holder("row-panini", "panini")]],
      ]),
    });
    expect(plan.buckets.get("topps")).toEqual([set("Shared Set", "bsc-1")]);
    expect(plan.buckets.has("panini")).toBe(false);
    expect(plan.moves).toEqual([]);
  });

  test("a holder whose parent no longer appears in `manufacturers` (deleted row) is treated as Unknown-less: it still counts as a brand holder and nothing moves", () => {
    // The router only ever consults `manufacturers` to know which ids are the
    // flagged row; a holder whose parent id is absent from that list is not
    // recognised as Unknown, so it is NOT re-homed — it is left exactly where
    // routeBscSets found it, which is the safe default when a parent's own
    // row went missing between the read and the sync.
    const plan = routeBscSets({
      sets: [set("Orphaned Set", "bsc-1")],
      manufacturers: [mfr("topps", { prefix: "Topps" })],
      holdersByBscId: new Map([["bsc-1", [holder("row-1", "deleted-parent")]]]),
    });
    expect(plan.buckets.get("deleted-parent")).toEqual([
      set("Orphaned Set", "bsc-1"),
    ]);
    expect(plan.moves).toEqual([]);
  });

  test("two Unknown-held rows with the same target brand each move once, no duplicate moves", () => {
    const plan = routeBscSets({
      sets: [set("Topps Chrome", "bsc-1"), set("Topps Chrome", "bsc-1")],
      manufacturers: [mfr("topps", { prefix: "Topps" }), mfr("unk", { unknown: true })],
      holdersByBscId: new Map([["bsc-1", [holder("row-1", "unk")]]]),
    });
    expect(plan.moves).toEqual([
      { rowId: "row-1", fromId: "unk", toId: "topps" },
    ]);
    expect(plan.buckets.get("topps")).toHaveLength(2);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// knownSetNameKeys / routeSlSets (D11)
// ───────────────────────────────────────────────────────────────────────────

describe("knownSetNameKeys", () => {
  test("keys both the row's own value and brandPrefix + value", () => {
    const keys = knownSetNameKeys([{ value: "Chrome", brandPrefix: "Topps" }]);
    expect(keys.has("chrome")).toBe(true);
    expect(keys.has("topps chrome")).toBe(true);
  });

  test("a row with no brandPrefix contributes only its own value", () => {
    const keys = knownSetNameKeys([{ value: "Bowman" }]);
    expect(keys).toEqual(new Set(["bowman"]));
  });

  test("skips a blank value", () => {
    const keys = knownSetNameKeys([{ value: "   " }]);
    expect(keys.size).toBe(0);
  });
});

describe("routeSlSets", () => {
  test("an entry whose id is already covered is not offered as new, and is not double-counted with variants", () => {
    const plan = routeSlSets({
      entries: [{ id: "sl-1", label: "Series 1" }],
      coveredSlIds: new Set(["sl-1"]),
      knownSetNameKeys: new Set(),
    });
    expect(plan.covered).toBe(1);
    expect(plan.variants).toBe(0);
    expect(plan.roots).toEqual([]);
  });

  test("a label equal to a known set is a variant, not new", () => {
    const plan = routeSlSets({
      entries: [{ id: "sl-1", label: "Chrome" }],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(["chrome"]),
    });
    expect(plan.variants).toBe(1);
    expect(plan.roots).toEqual([]);
  });

  test("a label that is a known set + suffix is a variant (word-boundary prefix)", () => {
    const plan = routeSlSets({
      entries: [{ id: "sl-1", label: "Chrome Sepia Refractor" }],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(["chrome"]),
    });
    expect(plan.variants).toBe(1);
  });

  test("the scope's own prefix re-forms the label to hide a full-year Unknown listing under the real brand's known set", () => {
    // Under Unknown's full-year list the label still carries "Topps "; the
    // brand's known set is stored as "Topps Chrome" (prefix stripped at
    // creation is not how NB names it — the known key carries the prefix).
    const plan = routeSlSets({
      entries: [{ id: "sl-1", label: "Chrome Sepia Refractor" }],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(["topps chrome"]),
      scopePrefix: "Topps",
    });
    expect(plan.variants).toBe(1);
  });

  test("a flagship set named after its own brand hides only an exact match, never by prefix", () => {
    // Coordinator fix round: without the flagship carve-out, "Topps" as a
    // known set name would prefix-hide EVERY entry re-prefixed with "Topps"
    // ("Topps Heritage", "Topps Finest", ...), hiding the whole brand.
    const plan = routeSlSets({
      entries: [
        { id: "sl-1", label: "Topps" }, // exact match to the flagship — hidden
        { id: "sl-2", label: "Heritage" }, // a real new set — must surface
      ],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(["topps"]),
      scopePrefix: "Topps",
    });
    expect(plan.variants).toBe(1);
    expect(plan.roots.map((r) => r.label)).toEqual(["Heritage"]);
  });

  test("Topps Heritage surfaces as a root when only 'Topps' (the flagship) is known", () => {
    const plan = routeSlSets({
      entries: [{ id: "sl-1", label: "Heritage" }],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(["topps"]),
      scopePrefix: "Topps",
    });
    expect(plan.variants).toBe(0);
    expect(plan.roots.map((r) => r.label)).toEqual(["Heritage"]);
  });

  test("a label NOT prefixing any known set, and not prefixed BY one, is new", () => {
    const plan = routeSlSets({
      entries: [{ id: "sl-1", label: "Finest" }],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(["chrome"]),
    });
    expect(plan.variants).toBe(0);
    expect(plan.roots.map((r) => r.label)).toEqual(["Finest"]);
  });

  test("two roots where one prefixes the other join into one root with the shorter as root", () => {
    const plan = routeSlSets({
      entries: [
        { id: "sl-2", label: "Finest Refractor" },
        { id: "sl-1", label: "Finest" },
      ],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(),
    });
    expect(plan.roots).toHaveLength(1);
    expect(plan.roots[0].label).toBe("Finest");
    expect(plan.roots[0].members).toEqual([
      { id: "sl-2", label: "Finest Refractor" },
    ]);
  });

  test("two entries with the identical folded label fold together, the first becomes the root", () => {
    const plan = routeSlSets({
      entries: [
        { id: "sl-1", label: "Finest" },
        { id: "sl-2", label: "finest" },
      ],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(),
    });
    expect(plan.roots).toHaveLength(1);
    // The shortest-first / stable-tie sort makes sl-1 the root deterministically.
    expect(plan.roots[0].id).toBe("sl-1");
    expect(plan.roots[0].members.map((m) => m.id)).toEqual(["sl-2"]);
  });

  test("members past MAX_SL_SET_MEMBERS are dropped and counted, root kept", () => {
    const entries = [{ id: "root", label: "Finest" }];
    for (let i = 0; i < MAX_SL_SET_MEMBERS + 5; i++) {
      entries.push({ id: `m${i}`, label: `Finest Variant ${i}` });
    }
    const plan = routeSlSets({
      entries,
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(),
    });
    expect(plan.roots).toHaveLength(1);
    expect(plan.roots[0].members).toHaveLength(MAX_SL_SET_MEMBERS);
    expect(plan.membersTruncated).toBe(5);
  });

  test("roots past MAX_SL_SETS_PER_SYNC are dropped AFTER sorting by folded label, and the cap is stable across runs", () => {
    const entries = Array.from({ length: MAX_SL_SETS_PER_SYNC + 3 }, (_, i) => ({
      id: `id-${i}`,
      // Distinct, unrelated stems so every entry is its own root.
      label: `Root-${String(i).padStart(4, "0")}`,
    }));
    // Shuffle the input order — the cap must not depend on scan order.
    const shuffled = [...entries].reverse();

    const planA = routeSlSets({
      entries,
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(),
    });
    const planB = routeSlSets({
      entries: shuffled,
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(),
    });

    expect(planA.roots).toHaveLength(MAX_SL_SETS_PER_SYNC);
    expect(planA.rootsTruncated).toBe(3);
    // Same window of roots (by id) regardless of input order.
    expect(planA.roots.map((r) => r.id)).toEqual(planB.roots.map((r) => r.id));
    // And it is the alphabetically-FIRST window that survives — "Root-0000"
    // through the 200th, never a rotating tail.
    expect(planA.roots[0].label).toBe("Root-0000");
  });

  test("a root near the truncation boundary keeps its slot across two runs with the same input", () => {
    // Sorting before the cap means the same input always yields the same
    // surviving root set, so what one sync cut off is exactly what the next
    // sync (with this one's roots now covered) reaches first — nothing past
    // the cap is lost, only deferred.
    const entries = Array.from({ length: MAX_SL_SETS_PER_SYNC + 1 }, (_, i) => ({
      id: `id-${i}`,
      label: `Root-${String(i).padStart(4, "0")}`,
    }));
    const first = routeSlSets({
      entries,
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(),
    });
    const second = routeSlSets({
      entries,
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(),
    });
    expect(first.roots.map((r) => r.id)).toEqual(second.roots.map((r) => r.id));
  });

  test("duplicate ids in the entry list are counted once", () => {
    const plan = routeSlSets({
      entries: [
        { id: "sl-1", label: "Finest" },
        { id: "sl-1", label: "Finest" },
      ],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(),
    });
    expect(plan.roots).toHaveLength(1);
    expect(plan.roots[0].members).toEqual([]);
  });

  test("an unnameable (over-length) label is dropped and counted, never becomes a root", () => {
    const plan = routeSlSets({
      entries: [{ id: "sl-1", label: "X".repeat(500) }],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(),
    });
    expect(plan.unnameable).toBe(1);
    expect(plan.roots).toEqual([]);
  });

  test("an entry with a blank label is dropped silently (not unnameable, not a root)", () => {
    const plan = routeSlSets({
      entries: [{ id: "sl-1", label: "   " }],
      coveredSlIds: new Set(),
      knownSetNameKeys: new Set(),
    });
    expect(plan.unnameable).toBe(0);
    expect(plan.roots).toEqual([]);
    expect(plan.variants).toBe(0);
    expect(plan.covered).toBe(0);
  });
});
