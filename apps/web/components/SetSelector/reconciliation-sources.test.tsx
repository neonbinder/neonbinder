/**
 * NEO-496 — the N-source reducer behind the Reconcile dialog.
 *
 * `.tsx` on purpose: a `.test.ts` under components/ is collected by nothing
 * (vitest.include.mjs), and the completeness verifier fails the run on it.
 *
 * This module holds no matching heuristics. A tie in auto-pairing (product
 * rule 8) is decided in pairing-cards; the equivalent guarantee here is that
 * the reducer never silently picks a winner: an item that is not explicitly
 * acted on stays Pending, and an id mapped by two sets is allowed, never
 * resolved by the reducer.
 */

import { describe, expect, test } from "vitest";
import {
  BSC_SOURCE,
  CHECKLIST_SOURCE,
  MARKETPLACE_SOURCES,
  SOURCES_WITH_CHECKLIST,
  SOURCE_KEYS,
  SOURCE_TOKEN,
  SPORTLOTS_SOURCE,
  bySource,
  checklistSetTitle,
  defaultTitleOf,
  isMarketplaceSource,
  linksOf,
  reconcileSources,
  reconciliationReducer,
  type PlatformItem,
  type ReadySet,
  type ReconciliationState,
} from "./reconciliation-sources";

const it_ = (platformValue: string, value = platformValue): PlatformItem => ({
  value,
  platformValue,
});

const emptyState = (over: Partial<ReconciliationState> = {}): ReconciliationState => ({
  ready: [],
  pending: bySource<PlatformItem[]>(() => []),
  seq: 0,
  ...over,
});

const pendingOf = (
  p: Partial<Record<"bsc" | "sportlots" | "checklist", PlatformItem[]>>,
) => ({ ...bySource<PlatformItem[]>(() => []), ...p });

const readySet = (key: string, title: string, links = linksOf()): ReadySet => ({
  key,
  title,
  links,
  confidence: 0,
});

describe("source descriptors", () => {
  test("columns are in BSC, SportLots, checklist order", () => {
    expect(SOURCES_WITH_CHECKLIST.map((s) => s.key)).toEqual(["bsc", "sportlots", "checklist"]);
    expect(MARKETPLACE_SOURCES).toEqual([BSC_SOURCE, SPORTLOTS_SOURCE]);
    expect(SOURCE_KEYS).toEqual(["bsc", "sportlots", "checklist"]);
  });

  test("only the checklist is not a marketplace", () => {
    expect(SOURCE_KEYS.map(isMarketplaceSource)).toEqual([true, true, false]);
    expect(CHECKLIST_SOURCE.kind).toBe("checklist");
    expect(BSC_SOURCE.kind).toBe("marketplace");
  });

  test("DOM tokens keep SportLots as sl", () => {
    expect(SOURCE_TOKEN).toEqual({ bsc: "bsc", sportlots: "sl", checklist: "checklist" });
  });
});

describe("titles", () => {
  test("an all-capitals checklist name becomes Title Case", () => {
    expect(checklistSetTitle("TOPPS CHROME RADIATING ROOKIES")).toBe(
      "Topps Chrome Radiating Rookies",
    );
  });

  test("capitalises after hyphen, slash and parenthesis", () => {
    expect(checklistSetTitle("RED-HOT (SP)/BLUE")).toBe("Red-Hot (Sp)/Blue");
  });

  test("a name with any lower-case letter keeps the publisher's casing", () => {
    expect(checklistSetTitle("  Future Stars ")).toBe("Future Stars");
    expect(checklistSetTitle("DiamondKings")).toBe("DiamondKings");
  });

  test("a name with no letters is only trimmed", () => {
    expect(checklistSetTitle(" 1996 ")).toBe("1996");
  });

  test("a checklist item takes the casing rule, a marketplace item its name verbatim", () => {
    expect(defaultTitleOf("checklist", it_("k", "BASE RED"))).toBe("Base Red");
    expect(defaultTitleOf("bsc", it_("1", "BASE RED"))).toBe("BASE RED");
    expect(defaultTitleOf("sportlots", it_("2", "BASE RED"))).toBe("BASE RED");
  });
});

describe("linksOf and bySource", () => {
  test("linksOf puts each item on its own source and nothing elsewhere", () => {
    const a = it_("1");
    const b = it_("2");
    expect(linksOf({ source: "bsc", item: a }, { source: "checklist", item: b })).toEqual({
      bsc: [a],
      sportlots: [],
      checklist: [b],
    });
  });

  test("bySource calls make once per source in order", () => {
    const seen: string[] = [];
    bySource((k) => seen.push(k));
    expect(seen).toEqual(["bsc", "sportlots", "checklist"]);
  });
});

describe("PROMOTE_PAIR", () => {
  test("two sources make one set titled from the earlier source, both leave Pending", () => {
    const bsc = it_("b1", "Base Set");
    const sl = it_("s1", "Base");
    const state = emptyState({ pending: pendingOf({ bsc: [bsc], sportlots: [sl] }) });
    const next = reconcileSources(state, {
      type: "PROMOTE_PAIR",
      a: { source: "sportlots", item: sl },
      b: { source: "bsc", item: bsc },
    });
    expect(next.ready).toEqual([
      {
        key: "set-0",
        title: "Base Set",
        links: { bsc: [bsc], sportlots: [sl], checklist: [] },
        confidence: 0,
      },
    ]);
    expect(next.pending).toEqual(pendingOf({}));
    expect(next.seq).toBe(1);
  });

  test("three sources: pairing a checklist section with SportLots, then attaching BSC", () => {
    const bsc = it_("b1", "Chrome");
    const sl = it_("s1", "Chrome SL");
    const cl = it_("chrome", "TOPPS CHROME");
    let state = emptyState({
      pending: pendingOf({ bsc: [bsc], sportlots: [sl], checklist: [cl] }),
    });
    state = reconcileSources(state, {
      type: "PROMOTE_PAIR",
      a: { source: "checklist", item: cl },
      b: { source: "sportlots", item: sl },
    });
    // SportLots outranks the checklist for the default title.
    expect(state.ready[0].title).toBe("Chrome SL");
    state = reconcileSources(state, { type: "ATTACH", key: "set-0", source: "bsc", item: bsc });
    expect(state.ready[0].links).toEqual({ bsc: [bsc], sportlots: [sl], checklist: [cl] });
    expect(state.pending).toEqual(pendingOf({}));
  });

  test("a checklist section paired with BSC is titled from BSC", () => {
    const next = reconcileSources(emptyState(), {
      type: "PROMOTE_PAIR",
      a: { source: "checklist", item: it_("k", "X") },
      b: { source: "bsc", item: it_("1", "Y") },
    });
    expect(next.ready[0].title).toBe("Y");
  });

  test("a checklist-only pairing title is Title Cased only for the checklist item", () => {
    const next = reconcileSources(emptyState(), {
      type: "PROMOTE_PAIR",
      a: { source: "checklist", item: it_("k", "BASE RED") },
      b: { source: "sportlots", item: it_("2", "Red") },
    });
    expect(next.ready[0].title).toBe("Red");
  });

  test("two items from the same source return the very same state", () => {
    const state = emptyState();
    expect(
      reconcileSources(state, {
        type: "PROMOTE_PAIR",
        a: { source: "bsc", item: it_("1") },
        b: { source: "bsc", item: it_("2") },
      }),
    ).toBe(state);
  });
});

describe("PROMOTE_SOLO and checklist-only rows", () => {
  test("a checklist section becomes its own set, Title Cased, marked ownSet", () => {
    const cl = it_("future stars", "FUTURE STARS");
    const state = emptyState({ pending: pendingOf({ checklist: [cl, it_("other")] }) });
    const next = reconcileSources(state, { type: "PROMOTE_SOLO", source: "checklist", item: cl });
    expect(next.ready).toEqual([
      {
        key: "set-0",
        title: "Future Stars",
        links: { bsc: [], sportlots: [], checklist: [cl] },
        confidence: 0,
        ownSet: true,
      },
    ]);
    expect(next.pending.checklist).toEqual([it_("other")]);
  });

  test("promoting an item that is not Pending still makes the set and leaves Pending alone", () => {
    const pending = pendingOf({ bsc: [it_("other")] });
    const next = reconcileSources(emptyState({ pending }), {
      type: "PROMOTE_SOLO",
      source: "bsc",
      item: it_("gone"),
    });
    expect(next.ready).toHaveLength(1);
    expect(next.pending.bsc).toBe(pending.bsc);
  });
});

describe("PROMOTE_SOLO_MANY", () => {
  test("makes one set per item in order with consecutive keys", () => {
    const items = [it_("a"), it_("b"), it_("c")];
    const next = reconcileSources(
      emptyState({ seq: 5, pending: pendingOf({ sportlots: [...items, it_("z")] }) }),
      { type: "PROMOTE_SOLO_MANY", source: "sportlots", items },
    );
    expect(next.ready.map((s) => s.key)).toEqual(["set-5", "set-6", "set-7"]);
    expect(next.ready.every((s) => s.ownSet === true)).toBe(true);
    expect(next.seq).toBe(8);
    expect(next.pending.sportlots).toEqual([it_("z")]);
  });

  test("an item listed twice becomes one set", () => {
    const next = reconcileSources(emptyState(), {
      type: "PROMOTE_SOLO_MANY",
      source: "bsc",
      items: [it_("a"), it_("a")],
    });
    expect(next.ready).toHaveLength(1);
    expect(next.seq).toBe(1);
  });

  test("an empty list returns the very same state", () => {
    const state = emptyState();
    expect(
      reconcileSources(state, { type: "PROMOTE_SOLO_MANY", source: "bsc", items: [] }),
    ).toBe(state);
  });

  test("checklist items are Title Cased like PROMOTE_SOLO", () => {
    const next = reconcileSources(emptyState(), {
      type: "PROMOTE_SOLO_MANY",
      source: "checklist",
      items: [it_("a", "BASE"), it_("b", "Inserts")],
    });
    expect(next.ready.map((s) => s.title)).toEqual(["Base", "Inserts"]);
  });
});

describe("ATTACH", () => {
  const base = (): ReconciliationState =>
    emptyState({
      ready: [readySet("set-0", "A", linksOf({ source: "bsc", item: it_("b1") }))],
      pending: pendingOf({ checklist: [it_("sec")], sportlots: [it_("s1")] }),
      seq: 1,
    });

  test("attaches a checklist section and removes it from Pending", () => {
    const next = reconcileSources(base(), {
      type: "ATTACH",
      key: "set-0",
      source: "checklist",
      item: it_("sec"),
    });
    expect(next.ready[0].links.checklist).toEqual([it_("sec")]);
    expect(next.pending.checklist).toEqual([]);
  });

  test("a set can hold several items from one source", () => {
    let state = base();
    state = reconcileSources(state, { type: "ATTACH", key: "set-0", source: "bsc", item: it_("b2") });
    expect(state.ready[0].links.bsc).toEqual([it_("b1"), it_("b2")]);
  });

  test("the same id twice on one set returns the same state", () => {
    const state = base();
    expect(
      reconcileSources(state, { type: "ATTACH", key: "set-0", source: "bsc", item: it_("b1") }),
    ).toBe(state);
  });

  test("the same id on two different sets is allowed and not consumed from Pending twice", () => {
    let state = emptyState({
      ready: [readySet("set-0", "A"), readySet("set-1", "B")],
      pending: pendingOf({ sportlots: [it_("s1")] }),
    });
    state = reconcileSources(state, { type: "ATTACH", key: "set-0", source: "sportlots", item: it_("s1") });
    state = reconcileSources(state, { type: "ATTACH", key: "set-1", source: "sportlots", item: it_("s1") });
    expect(state.ready.map((s) => s.links.sportlots)).toEqual([[it_("s1")], [it_("s1")]]);
    expect(state.pending.sportlots).toEqual([]);
  });

  test("an unknown set key returns the same state", () => {
    const state = base();
    expect(
      reconcileSources(state, { type: "ATTACH", key: "nope", source: "bsc", item: it_("x") }),
    ).toBe(state);
  });

  test("a checklist section is refused on a set whose checklist links are unknown", () => {
    const locked: ReadySet = { ...readySet("set-0", "A"), checklistLinksUnknown: true };
    const state = emptyState({ ready: [locked], pending: pendingOf({ checklist: [it_("sec")] }) });
    expect(
      reconcileSources(state, { type: "ATTACH", key: "set-0", source: "checklist", item: it_("sec") }),
    ).toBe(state);
  });

  test("a marketplace item still attaches to a set whose checklist links are unknown", () => {
    const locked: ReadySet = { ...readySet("set-0", "A"), checklistLinksUnknown: true };
    const next = reconcileSources(emptyState({ ready: [locked] }), {
      type: "ATTACH",
      key: "set-0",
      source: "bsc",
      item: it_("b"),
    });
    expect(next.ready[0].links.bsc).toEqual([it_("b")]);
  });
});

describe("DETACH", () => {
  test("returns the item to Pending and keeps the set while it has other links", () => {
    const state = emptyState({
      ready: [
        readySet(
          "set-0",
          "A",
          linksOf({ source: "bsc", item: it_("b1") }, { source: "checklist", item: it_("sec") }),
        ),
      ],
    });
    const next = reconcileSources(state, {
      type: "DETACH",
      key: "set-0",
      source: "checklist",
      platformValue: "sec",
    });
    expect(next.ready[0].links).toEqual({ bsc: [it_("b1")], sportlots: [], checklist: [] });
    expect(next.pending.checklist).toEqual([it_("sec")]);
  });

  test("detaching a set's last link removes the set", () => {
    const state = emptyState({
      ready: [readySet("set-0", "A", linksOf({ source: "checklist", item: it_("sec") }))],
    });
    const next = reconcileSources(state, {
      type: "DETACH",
      key: "set-0",
      source: "checklist",
      platformValue: "sec",
    });
    expect(next.ready).toEqual([]);
    expect(next.pending.checklist).toEqual([it_("sec")]);
  });

  test("an id already in Pending is not duplicated when detached", () => {
    const state = emptyState({
      ready: [readySet("set-0", "A", linksOf({ source: "bsc", item: it_("b1") }, { source: "sportlots", item: it_("s") }))],
      pending: pendingOf({ bsc: [it_("b1")] }),
    });
    const next = reconcileSources(state, {
      type: "DETACH",
      key: "set-0",
      source: "bsc",
      platformValue: "b1",
    });
    expect(next.pending.bsc).toEqual([it_("b1")]);
  });

  test("an unknown key or an unmapped id returns the same state", () => {
    const state = emptyState({ ready: [readySet("set-0", "A", linksOf({ source: "bsc", item: it_("b1") }))] });
    expect(
      reconcileSources(state, { type: "DETACH", key: "x", source: "bsc", platformValue: "b1" }),
    ).toBe(state);
    expect(
      reconcileSources(state, { type: "DETACH", key: "set-0", source: "bsc", platformValue: "zz" }),
    ).toBe(state);
  });
});

describe("DISBAND", () => {
  test("returns every link to its own source's Pending, without doubling ids", () => {
    const state = emptyState({
      ready: [
        readySet(
          "set-0",
          "A",
          linksOf(
            { source: "bsc", item: it_("b1") },
            { source: "sportlots", item: it_("s1") },
            { source: "checklist", item: it_("c1") },
          ),
        ),
        readySet("set-1", "B", linksOf({ source: "sportlots", item: it_("s1") })),
      ],
      pending: pendingOf({ bsc: [it_("b1")] }),
    });
    const next = reconcileSources(state, { type: "DISBAND", key: "set-0" });
    expect(next.ready.map((s) => s.key)).toEqual(["set-1"]);
    expect(next.pending).toEqual(
      pendingOf({ bsc: [it_("b1")], sportlots: [it_("s1")], checklist: [it_("c1")] }),
    );
  });

  test("an unknown key returns the same state", () => {
    const state = emptyState();
    expect(reconcileSources(state, { type: "DISBAND", key: "x" })).toBe(state);
  });
});

describe("RENAME and UPDATE_METADATA", () => {
  test("rename changes only the named set's title", () => {
    const state = emptyState({ ready: [readySet("a", "A"), readySet("b", "B")] });
    const next = reconcileSources(state, { type: "RENAME", key: "b", title: "Bee" });
    expect(next.ready.map((s) => s.title)).toEqual(["A", "Bee"]);
  });

  test("metadata merges into what is there", () => {
    const withMeta: ReadySet = { ...readySet("a", "A"), metadata: { cardNumberPrefix: "X" } };
    const next = reconcileSources(emptyState({ ready: [withMeta] }), {
      type: "UPDATE_METADATA",
      key: "a",
      metadata: { cardNumberPrefix: "Y" },
    });
    expect(next.ready[0].metadata).toEqual({ cardNumberPrefix: "Y" });
  });
});

describe("duplicate Pending ids", () => {
  test("PROMOTE_SOLO removes every Pending entry sharing the id", () => {
    const state = emptyState({ pending: pendingOf({ bsc: [it_("d"), it_("d"), it_("e")] }) });
    const next = reconcileSources(state, { type: "PROMOTE_SOLO", source: "bsc", item: it_("d") });
    expect(next.pending.bsc).toEqual([it_("e")]);
  });
});

describe("unknown action", () => {
  test("returns the same state", () => {
    const state = emptyState();
    expect(
      reconcileSources(state, { type: "NOPE" } as unknown as Parameters<typeof reconcileSources>[1]),
    ).toBe(state);
  });
});

describe("reconciliationReducer (two-marketplace vocabulary)", () => {
  const two = (over = {}) => ({
    ready: [] as ReadySet[],
    pendingBsc: [it_("b1", "Base")],
    pendingSl: [it_("s1", "Base SL")],
    seq: 0,
    ...over,
  });

  test("PROMOTE_PAIR maps bsc and sl onto the matching sources", () => {
    const next = reconciliationReducer(two(), { type: "PROMOTE_PAIR", bsc: it_("b1", "Base"), sl: it_("s1", "Base SL") });
    expect(next.ready[0].links).toEqual({
      bsc: [it_("b1", "Base")],
      sportlots: [it_("s1", "Base SL")],
      checklist: [],
    });
    expect(next.ready[0].title).toBe("Base");
    expect(next.pendingBsc).toEqual([]);
    expect(next.pendingSl).toEqual([]);
    expect(next.seq).toBe(1);
  });

  test("PROMOTE_SOLO_MANY on sl uses the SportLots list", () => {
    const next = reconciliationReducer(two(), {
      type: "PROMOTE_SOLO_MANY",
      side: "sl",
      items: [it_("s1", "Base SL")],
    });
    expect(next.ready[0].links.sportlots).toEqual([it_("s1", "Base SL")]);
    expect(next.pendingSl).toEqual([]);
    expect(next.pendingBsc).toEqual([it_("b1", "Base")]);
  });

  test("a no-op returns the very state it was given", () => {
    const state = two();
    expect(reconciliationReducer(state, { type: "DISBAND", key: "nope" })).toBe(state);
  });

  test("DETACH and ATTACH translate the side", () => {
    let state = reconciliationReducer(two(), {
      type: "PROMOTE_SOLO",
      side: "bsc",
      item: it_("b1", "Base"),
    });
    state = reconciliationReducer(state, { type: "ATTACH", key: "set-0", side: "sl", item: it_("s1", "Base SL") });
    expect(state.ready[0].links.sportlots).toEqual([it_("s1", "Base SL")]);
    state = reconciliationReducer(state, { type: "DETACH", key: "set-0", side: "sl", platformValue: "s1" });
    expect(state.ready[0].links.sportlots).toEqual([]);
    expect(state.pendingSl).toEqual([it_("s1", "Base SL")]);
  });
});
