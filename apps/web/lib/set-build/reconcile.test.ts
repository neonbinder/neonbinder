/**
 * NEO-339 — direct tests for `applyExplicitPairs`, the set-building tool's
 * pairing entry point. The component tests cover the reducer and the seed
 * through the dialog; nothing there reaches this function, so each rule in its
 * docstring is pinned here.
 */
import { describe, expect, it } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import {
  applyExplicitPairs,
  defaultSlPrefixes,
  inSlPrefixScope,
  type PlatformItem,
  type ReadySet,
  type ReconciliationState,
} from "./reconcile";

const item = (value: string, platformValue: string): PlatformItem => ({
  value,
  platformValue,
});

const ready = (
  key: string,
  title: string,
  bsc: PlatformItem[],
  sl: PlatformItem[],
  extra: Partial<ReadySet> = {},
): ReadySet => ({ key, title, bsc, sl, confidence: 1, ...extra });

const stateOf = (
  parts: Partial<ReconciliationState> = {},
): ReconciliationState => ({
  ready: [],
  pendingBsc: [],
  pendingSl: [],
  seq: 0,
  ...parts,
});

const EXISTING = "row-1" as Id<"selectorOptions">;
const EXISTING_2 = "row-2" as Id<"selectorOptions">;

const ids = (items: PlatformItem[]) => items.map((i) => i.platformValue);

describe("applyExplicitPairs: placing a new set", () => {
  it("builds a set from the exact ids a pair names, titled with the pair's name", () => {
    const out = applyExplicitPairs(
      stateOf({
        pendingBsc: [item("Topps", "b1")],
        pendingSl: [item("Topps 1990", "s1")],
      }),
      [{ name: "1990 Topps", bsc: ["b1"], sportlots: ["s1"] }],
      [],
    );
    expect(out.state.ready).toHaveLength(1);
    expect(out.state.ready[0].title).toBe("1990 Topps");
    expect(ids(out.state.ready[0].bsc)).toEqual(["b1"]);
    expect(ids(out.state.ready[0].sl)).toEqual(["s1"]);
    expect(out.state.pendingBsc).toEqual([]);
    expect(out.state.pendingSl).toEqual([]);
    expect(out.unmatchedPairs).toEqual([]);
    expect(out.unaddressedPending).toEqual([]);
  });

  it("picks the pending item by id, not by its position in Pending", () => {
    const out = applyExplicitPairs(
      stateOf({
        pendingBsc: [item("First", "b1"), item("Second", "b2"), item("Third", "b3")],
        pendingSl: [item("SL First", "s1"), item("SL Second", "s2")],
      }),
      [{ name: "Mine", bsc: ["b3"], sportlots: ["s2"] }],
      [],
    );
    expect(ids(out.state.ready[0].bsc)).toEqual(["b3"]);
    expect(ids(out.state.ready[0].sl)).toEqual(["s2"]);
    expect(ids(out.state.pendingBsc)).toEqual(["b1", "b2"]);
    expect(ids(out.state.pendingSl)).toEqual(["s1"]);
  });

  it("matches on the id even when another pending item carries the same display name", () => {
    const out = applyExplicitPairs(
      stateOf({
        pendingBsc: [item("Twin", "b1"), item("Twin", "b2")],
      }),
      [{ name: "Twin set", bsc: ["b2"] }],
      [],
    );
    expect(ids(out.state.ready[0].bsc)).toEqual(["b2"]);
    expect(ids(out.state.pendingBsc)).toEqual(["b1"]);
  });

  it("appends new sets in the order the pairs are given, whatever order Pending holds", () => {
    const out = applyExplicitPairs(
      stateOf({
        pendingBsc: [item("A", "b1"), item("B", "b2"), item("C", "b3")],
      }),
      [
        { name: "Third", bsc: ["b3"] },
        { name: "First", bsc: ["b1"] },
        { name: "Second", bsc: ["b2"] },
      ],
      [],
    );
    expect(out.state.ready.map((s) => s.title)).toEqual(["Third", "First", "Second"]);
    expect(out.state.ready.map((s) => ids(s.bsc))).toEqual([["b3"], ["b1"], ["b2"]]);
  });

  it("appends after the sets already Ready and keeps their keys", () => {
    const kept = ready("set-0", "Saved", [item("Saved", "b9")], [], {
      existingId: EXISTING,
    });
    const out = applyExplicitPairs(
      stateOf({ ready: [kept], pendingBsc: [item("New", "b1")], seq: 1 }),
      [
        { name: "Saved", bsc: ["b9"] },
        { name: "New", bsc: ["b1"] },
      ],
      [],
    );
    expect(out.state.ready.map((s) => s.key)).toEqual(["set-0", "set-1"]);
    expect(out.state.ready[0]).toEqual(kept);
  });

  it("attaches every extra id on each side to the new set", () => {
    const out = applyExplicitPairs(
      stateOf({
        pendingBsc: [item("B1", "b1"), item("B2", "b2")],
        pendingSl: [item("S1", "s1"), item("S2", "s2"), item("S3", "s3")],
      }),
      [{ name: "Wide", bsc: ["b1", "b2"], sportlots: ["s1", "s2", "s3"] }],
      [],
    );
    expect(out.state.ready).toHaveLength(1);
    expect(ids(out.state.ready[0].bsc)).toEqual(["b1", "b2"]);
    expect(ids(out.state.ready[0].sl)).toEqual(["s1", "s2", "s3"]);
    expect(out.state.pendingBsc).toEqual([]);
    expect(out.state.pendingSl).toEqual([]);
  });

  it("makes a one-sided pair an own set (identity-only) with every id attached", () => {
    const out = applyExplicitPairs(
      stateOf({ pendingSl: [item("S1", "s1"), item("S2", "s2")] }),
      [{ name: "SL only", sportlots: ["s1", "s2"] }],
      [],
    );
    const made = out.state.ready[0];
    expect(made.title).toBe("SL only");
    expect(made.bsc).toEqual([]);
    expect(ids(made.sl)).toEqual(["s1", "s2"]);
    expect(made.ownSet).toBe(true);
  });

  it("leaves a two-sided pair's set without the own-set flag", () => {
    const out = applyExplicitPairs(
      stateOf({ pendingBsc: [item("B", "b1")], pendingSl: [item("S", "s1")] }),
      [{ name: "Both", bsc: ["b1"], sportlots: ["s1"] }],
      [],
    );
    expect(out.state.ready[0].ownSet).toBeUndefined();
  });

  it("shares an id a Ready set already holds instead of moving it", () => {
    const held = ready("set-0", "Held", [item("B", "b1")], [], {
      existingId: EXISTING,
    });
    const out = applyExplicitPairs(
      stateOf({ ready: [held], pendingBsc: [item("B2", "b2")], seq: 1 }),
      [{ name: "Another", bsc: ["b1", "b2"] }],
      [],
    );
    expect(out.state.ready).toHaveLength(2);
    expect(out.state.ready[0]).toEqual(held);
    expect(out.state.ready[1].title).toBe("Another");
    expect(ids(out.state.ready[1].bsc)).toEqual(["b1", "b2"]);
    expect(out.unaddressedReady).toEqual([held]);
  });
});

describe("applyExplicitPairs: pairs that cannot be applied", () => {
  it("reports a pair naming an id nobody has, and applies none of it", () => {
    const initial = stateOf({
      pendingBsc: [item("B", "b1")],
      pendingSl: [item("S", "s1")],
    });
    const pair = { name: "Half", bsc: ["b1"], sportlots: ["s1", "s-missing"] };
    const out = applyExplicitPairs(initial, [pair], []);
    expect(out.unmatchedPairs).toEqual([
      { pair, missing: [{ side: "sportlots", id: "s-missing" }] },
    ]);
    expect(out.state.ready).toEqual([]);
    expect(out.state.pendingBsc).toEqual(initial.pendingBsc);
    expect(out.state.pendingSl).toEqual(initial.pendingSl);
  });

  it("lists every missing id, on both sides", () => {
    const pair = { name: "None", bsc: ["bx"], sportlots: ["sx"] };
    const out = applyExplicitPairs(stateOf(), [pair], []);
    expect(out.unmatchedPairs[0].missing).toEqual([
      { side: "bsc", id: "bx" },
      { side: "sportlots", id: "sx" },
    ]);
  });

  it("does not match a missing id to a neighbour by position or by name", () => {
    const out = applyExplicitPairs(
      stateOf({ pendingBsc: [item("Topps", "b1"), item("Topps", "b2")] }),
      [{ name: "Topps", bsc: ["b3"] }],
      [],
    );
    expect(out.unmatchedPairs).toHaveLength(1);
    expect(out.state.ready).toEqual([]);
    expect(ids(out.state.pendingBsc)).toEqual(["b1", "b2"]);
  });

  it("treats a pair with no ids at all as unmatched, not as an empty set", () => {
    const pair = { name: "Empty" };
    const out = applyExplicitPairs(stateOf(), [pair], []);
    expect(out.unmatchedPairs).toEqual([{ pair, missing: [] }]);
    expect(out.state.ready).toEqual([]);
  });

  it("treats an id that is in the dialog but not in the fetch as missing when a fetch is given", () => {
    const pair = { name: "Stale", bsc: ["b1"] };
    const out = applyExplicitPairs(
      stateOf({ pendingBsc: [item("B", "b1")] }),
      [pair],
      [],
      { fetched: { bsc: ["b2"], sportlots: [] } },
    );
    expect(out.unmatchedPairs).toEqual([
      { pair, missing: [{ side: "bsc", id: "b1" }] },
    ]);
    expect(out.state.ready).toEqual([]);
  });

  it("accepts the same id when the fetch carries it", () => {
    const out = applyExplicitPairs(
      stateOf({ pendingBsc: [item("B", "b1")] }),
      [{ name: "Fresh", bsc: ["b1"] }],
      [],
      { fetched: { bsc: new Set(["b1"]), sportlots: [] } },
    );
    expect(out.unmatchedPairs).toEqual([]);
    expect(out.state.ready).toHaveLength(1);
  });

  it("keeps applying the pairs that are fine when another one is unmatched", () => {
    const out = applyExplicitPairs(
      stateOf({ pendingBsc: [item("B", "b1")] }),
      [
        { name: "Bad", bsc: ["nope"] },
        { name: "Good", bsc: ["b1"] },
      ],
      [],
    );
    expect(out.unmatchedPairs).toHaveLength(1);
    expect(out.state.ready.map((s) => s.title)).toEqual(["Good"]);
  });
});

describe("applyExplicitPairs: a pair that equals a Ready set", () => {
  it("claims the set and renames it when the title differs, keeping its key and existingId", () => {
    const row = ready("set-0", "Old", [item("B", "b1")], [item("S", "s1")], {
      existingId: EXISTING,
    });
    const out = applyExplicitPairs(
      stateOf({ ready: [row], seq: 1 }),
      [{ name: "New", bsc: ["b1"], sportlots: ["s1"] }],
      [],
    );
    expect(out.state.ready).toHaveLength(1);
    expect(out.state.ready[0]).toMatchObject({
      key: "set-0",
      title: "New",
      existingId: EXISTING,
    });
    expect(out.disbanded).toEqual([]);
    expect(out.unaddressedReady).toEqual([]);
  });

  it("leaves the set untouched when the title already matches", () => {
    const row = ready("set-0", "Same", [item("B", "b1")], [], {
      existingId: EXISTING,
    });
    const out = applyExplicitPairs(
      stateOf({ ready: [row], seq: 1 }),
      [{ name: "Same", bsc: ["b1"] }],
      [],
    );
    expect(out.state.ready).toEqual([row]);
  });

  it("claims an auto-matched set too, rather than disbanding it", () => {
    const auto = ready("set-0", "Auto", [item("B", "b1")], [item("S", "s1")]);
    const out = applyExplicitPairs(
      stateOf({ ready: [auto], seq: 1 }),
      [{ name: "Auto", bsc: ["b1"], sportlots: ["s1"] }],
      [],
    );
    expect(out.state.ready).toEqual([auto]);
    expect(out.disbanded).toEqual([]);
  });

  it("matches the ids as a set, whatever order the pair lists them in", () => {
    const row = ready("set-0", "Wide", [item("B1", "b1"), item("B2", "b2")], [], {
      existingId: EXISTING,
    });
    const out = applyExplicitPairs(
      stateOf({ ready: [row], seq: 1 }),
      [{ name: "Wide", bsc: ["b2", "b1"] }],
      [],
    );
    expect(out.state.ready).toEqual([row]);
  });

  it("does not claim a set whose ids only overlap the pair, and builds a new set instead", () => {
    const row = ready("set-0", "Wide", [item("B1", "b1"), item("B2", "b2")], [], {
      existingId: EXISTING,
    });
    const out = applyExplicitPairs(
      stateOf({ ready: [row], seq: 1 }),
      [{ name: "Narrow", bsc: ["b1"] }],
      [],
    );
    expect(out.state.ready).toHaveLength(2);
    expect(out.state.ready[0]).toEqual(row);
    expect(out.state.ready[1].title).toBe("Narrow");
    expect(out.unaddressedReady).toEqual([row]);
  });

  it("does not claim a set that has an extra id on the other side", () => {
    const row = ready("set-0", "Both", [item("B", "b1")], [item("S", "s1")], {
      existingId: EXISTING,
    });
    const out = applyExplicitPairs(
      stateOf({ ready: [row], seq: 1 }),
      [{ name: "BSC only", bsc: ["b1"] }],
      [],
    );
    expect(out.state.ready).toHaveLength(2);
    expect(out.state.ready[1].sl).toEqual([]);
  });

  it("reports a pair as ambiguous when two Ready sets carry exactly its ids, and renames neither", () => {
    const a = ready("set-0", "A", [item("B", "b1")], [], { existingId: EXISTING });
    const b = ready("set-1", "B", [item("B", "b1")], [], { existingId: EXISTING_2 });
    const pair = { name: "Pick one", bsc: ["b1"] };
    const out = applyExplicitPairs(stateOf({ ready: [a, b], seq: 2 }), [pair], []);
    expect(out.ambiguousPairs).toEqual([pair]);
    expect(out.state.ready).toEqual([a, b]);
    expect(out.unaddressedReady).toEqual([a, b]);
    expect(out.unmatchedPairs).toEqual([]);
  });

  it("does not let the first of two identical sets win a tie", () => {
    const a = ready("set-0", "A", [item("B", "b1")], [], { existingId: EXISTING });
    const b = ready("set-1", "B", [item("B", "b1")], [], { existingId: EXISTING_2 });
    const out = applyExplicitPairs(
      stateOf({ ready: [a, b], seq: 2 }),
      [{ name: "A renamed", bsc: ["b1"] }],
      [],
    );
    expect(out.state.ready.map((s) => s.title)).toEqual(["A", "B"]);
  });

  it("lets two pairs with different ids each claim their own set", () => {
    const a = ready("set-0", "A", [item("B", "b1")], [], { existingId: EXISTING });
    const b = ready("set-1", "B", [item("B", "b2")], [], { existingId: EXISTING_2 });
    const out = applyExplicitPairs(
      stateOf({ ready: [a, b], seq: 2 }),
      [
        { name: "Second", bsc: ["b2"] },
        { name: "First", bsc: ["b1"] },
      ],
      [],
    );
    expect(out.state.ready.map((s) => [s.key, s.title])).toEqual([
      ["set-0", "First"],
      ["set-1", "Second"],
    ]);
  });
});

describe("applyExplicitPairs: Ready sets no pair names", () => {
  it("disbands an auto-matched set and sends its ids back to Pending", () => {
    const auto = ready("set-0", "Auto", [item("B", "b1")], [item("S", "s1")]);
    const out = applyExplicitPairs(stateOf({ ready: [auto], seq: 1 }), [], []);
    expect(out.disbanded).toEqual([auto]);
    expect(out.state.ready).toEqual([]);
    expect(ids(out.state.pendingBsc)).toEqual(["b1"]);
    expect(ids(out.state.pendingSl)).toEqual(["s1"]);
    expect(out.unaddressedPending.map((p) => [p.side, p.item.platformValue])).toEqual([
      ["bsc", "b1"],
      ["sportlots", "s1"],
    ]);
  });

  it("leaves a restored row alone and reports it", () => {
    const row = ready("set-0", "Saved", [item("B", "b1")], [item("S", "s1")], {
      existingId: EXISTING,
    });
    const out = applyExplicitPairs(stateOf({ ready: [row], seq: 1 }), [], []);
    expect(out.unaddressedReady).toEqual([row]);
    expect(out.disbanded).toEqual([]);
    expect(out.state.ready).toEqual([row]);
    expect(out.state.pendingBsc).toEqual([]);
  });

  it("sorts auto-matched and restored sets apart in one run", () => {
    const auto = ready("set-0", "Auto", [item("B", "b1")], []);
    const saved = ready("set-1", "Saved", [item("B", "b2")], [], {
      existingId: EXISTING,
    });
    const out = applyExplicitPairs(stateOf({ ready: [auto, saved], seq: 2 }), [], []);
    expect(out.disbanded.map((s) => s.key)).toEqual(["set-0"]);
    expect(out.unaddressedReady.map((s) => s.key)).toEqual(["set-1"]);
    expect(out.state.ready.map((s) => s.key)).toEqual(["set-1"]);
  });

  it("lets a pair re-use ids freed by a disbanded set", () => {
    const auto = ready("set-0", "Auto", [item("B", "b1")], [item("S", "s1")]);
    const out = applyExplicitPairs(
      stateOf({ ready: [auto], seq: 1 }),
      [{ name: "BSC alone", bsc: ["b1"] }],
      [],
    );
    expect(out.disbanded).toEqual([auto]);
    expect(out.state.ready).toHaveLength(1);
    expect(out.state.ready[0].title).toBe("BSC alone");
    expect(ids(out.state.pendingSl)).toEqual(["s1"]);
  });
});

describe("applyExplicitPairs: pending decisions", () => {
  it("promotes an 'own-set' pending item to a set of its own, named for the item", () => {
    const out = applyExplicitPairs(
      stateOf({ pendingBsc: [item("Solo", "b1")], pendingSl: [item("Solo SL", "s1")] }),
      [],
      [
        { side: "bsc", id: "b1", decision: "own-set" },
        { side: "sportlots", id: "s1", decision: "own-set" },
      ],
    );
    expect(out.state.ready.map((s) => [s.title, ids(s.bsc), ids(s.sl)])).toEqual([
      ["Solo", ["b1"], []],
      ["Solo SL", [], ["s1"]],
    ]);
    expect(out.state.ready.every((s) => s.ownSet === true)).toBe(true);
    expect(out.unaddressedPending).toEqual([]);
  });

  it("does nothing for 'leave' and does not report the item as unaddressed", () => {
    const out = applyExplicitPairs(
      stateOf({ pendingBsc: [item("Skip", "b1")] }),
      [],
      [{ side: "bsc", id: "b1", decision: "leave" }],
    );
    expect(out.state.ready).toEqual([]);
    expect(ids(out.state.pendingBsc)).toEqual(["b1"]);
    expect(out.unaddressedPending).toEqual([]);
    expect(out.unmatchedPending).toEqual([]);
  });

  it("reports a pending id that is not in the dialog as not-in-fetch", () => {
    const entry = { side: "bsc" as const, id: "nope", decision: "own-set" as const };
    const out = applyExplicitPairs(stateOf({ pendingBsc: [item("B", "b1")] }), [], [entry]);
    expect(out.unmatchedPending).toEqual([{ entry, reason: "not-in-fetch" }]);
    expect(out.state.ready).toEqual([]);
  });

  it("reports a pending id missing from the fetch as not-in-fetch even when the dialog has it", () => {
    const entry = { side: "bsc" as const, id: "b1", decision: "own-set" as const };
    const out = applyExplicitPairs(
      stateOf({ pendingBsc: [item("B", "b1")] }),
      [],
      [entry],
      { fetched: { bsc: [], sportlots: [] } },
    );
    expect(out.unmatchedPending).toEqual([{ entry, reason: "not-in-fetch" }]);
    expect(out.state.ready).toEqual([]);
  });

  it("reports an id a Ready set holds, but Pending does not, as not-pending", () => {
    const row = ready("set-0", "Saved", [item("B", "b1")], [], { existingId: EXISTING });
    const entry = { side: "bsc" as const, id: "b1", decision: "own-set" as const };
    const out = applyExplicitPairs(stateOf({ ready: [row], seq: 1 }), [], [entry]);
    expect(out.unmatchedPending).toEqual([{ entry, reason: "not-pending" }]);
    expect(out.state.ready).toEqual([row]);
  });

  it("reports an id a pair already used as not-pending", () => {
    const entry = { side: "bsc" as const, id: "b1", decision: "own-set" as const };
    const out = applyExplicitPairs(
      stateOf({ pendingBsc: [item("B", "b1")] }),
      [{ name: "Taken", bsc: ["b1"] }],
      [entry],
    );
    expect(out.unmatchedPending).toEqual([{ entry, reason: "not-pending" }]);
    expect(out.state.ready).toHaveLength(1);
  });

  it("looks the id up on the side it names", () => {
    const entry = { side: "sportlots" as const, id: "b1", decision: "own-set" as const };
    const out = applyExplicitPairs(stateOf({ pendingBsc: [item("B", "b1")] }), [], [entry]);
    expect(out.unmatchedPending).toEqual([{ entry, reason: "not-in-fetch" }]);
    expect(ids(out.state.pendingBsc)).toEqual(["b1"]);
  });

  it("can decide on an id freed by a disbanded set", () => {
    const auto = ready("set-0", "Auto", [item("B", "b1")], []);
    const out = applyExplicitPairs(
      stateOf({ ready: [auto], seq: 1 }),
      [],
      [{ side: "bsc", id: "b1", decision: "own-set" }],
    );
    expect(out.unmatchedPending).toEqual([]);
    expect(out.state.ready.map((s) => ids(s.bsc))).toEqual([["b1"]]);
  });

  it("reports every pending item no decision names, in column order, tagged by side", () => {
    const out = applyExplicitPairs(
      stateOf({
        pendingBsc: [item("B1", "b1"), item("B2", "b2")],
        pendingSl: [item("S1", "s1")],
      }),
      [],
      [{ side: "bsc", id: "b2", decision: "leave" }],
    );
    expect(out.unaddressedPending).toEqual([
      { side: "bsc", item: item("B1", "b1") },
      { side: "sportlots", item: item("S1", "s1") },
    ]);
  });

  it("runs pending decisions after the pairs, so a pair's new set comes first", () => {
    const out = applyExplicitPairs(
      stateOf({ pendingBsc: [item("Solo", "b1"), item("Paired", "b2")] }),
      [{ name: "Pair", bsc: ["b2"] }],
      [{ side: "bsc", id: "b1", decision: "own-set" }],
    );
    expect(out.state.ready.map((s) => s.title)).toEqual(["Pair", "Solo"]);
  });

  it("applies pending decisions in the order given", () => {
    const out = applyExplicitPairs(
      stateOf({ pendingBsc: [item("A", "b1"), item("B", "b2")] }),
      [],
      [
        { side: "bsc", id: "b2", decision: "own-set" },
        { side: "bsc", id: "b1", decision: "own-set" },
      ],
    );
    expect(out.state.ready.map((s) => s.title)).toEqual(["B", "A"]);
  });
});

describe("applyExplicitPairs: purity", () => {
  it("does not mutate the state it is given", () => {
    const initial = stateOf({
      ready: [ready("set-0", "Auto", [item("B", "b1")], [])],
      pendingBsc: [item("B2", "b2")],
      seq: 1,
    });
    const before = JSON.parse(JSON.stringify(initial));
    applyExplicitPairs(
      initial,
      [{ name: "X", bsc: ["b2"] }],
      [],
    );
    expect(initial).toEqual(before);
  });
});

describe("the SportLots prefix filter (shared with the set-building tool, NEO-339)", () => {
  it("defaultSlPrefixes: the set name, the name less its brand, then the extras; lower-cased, de-duped", () => {
    expect(defaultSlPrefixes("Topps Chrome", "Topps", ["Chrome", "Topps Chrome Refractor"])).toEqual([
      "topps chrome",
      "chrome",
      "topps chrome refractor",
    ]);
    // A set not named after its brand keeps only its own name.
    expect(defaultSlPrefixes("Bowman Chrome", "Topps")).toEqual(["bowman chrome"]);
    expect(defaultSlPrefixes("", "", [])).toEqual([]);
  });

  it("inSlPrefixScope: a starts-with test, case-folded; no prefixes passes everything", () => {
    const prefixes = defaultSlPrefixes("Topps Chrome", "Topps");
    expect(inSlPrefixScope("Chrome Refractors", prefixes)).toBe(true);
    expect(inSlPrefixScope("TOPPS CHROME Update", prefixes)).toBe(true);
    expect(inSlPrefixScope("Heritage Chrome", prefixes)).toBe(false);
    expect(inSlPrefixScope("Heritage Chrome", [])).toBe(true);
  });
});
