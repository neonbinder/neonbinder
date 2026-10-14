import { describe, expect, test } from "vitest";
import { fakeNbClient, row } from "./fake-nb-client";
import { reconcileVariants, ReconcileFetchError, splitMootLeaves } from "./reconcile-variants";
import { parseDeclaredPaused } from "./sync-column";
import type { ReconcileSync } from "../spec/schema";

const LIST = "selectorOptions:getSelectorOptions";
const FETCH = "setReconciliation:fetchRawOptions";
const STORE = "setReconciliation:storeReconciledOptions";

type Item = { value: string; platformValue: string };
const bsc = (value: string, platformValue: string): Item => ({ value, platformValue });
const sl = bsc;

interface Fetch {
  bscOptions: Item[];
  slOptions: Item[];
  autoMatched: Array<{ displayName: string; bsc: Item; sl: Item; confidence: number }>;
  unmatchedBsc: Item[];
  unmatchedSl: Item[];
  pausedSides?: string[];
  twinIds?: { bsc: string[]; sportlots: string[] };
}

const twoSided = (): Fetch => {
  const fsB = bsc("Future Stars", "fs");
  const fsS = sl("Topps Chrome Future Stars", "9001");
  const smB = bsc("Stars of MLB", "smlb");
  const smS = sl("Topps Chrome Stars of MLB", "9010");
  const cp = bsc("Chrome Prospects", "cp");
  const black = sl("Topps Chrome Black", "9020");
  const bowman = sl("Bowman Chrome", "9030");
  return {
    bscOptions: [fsB, smB, cp],
    slOptions: [fsS, smS, black, bowman],
    autoMatched: [
      { displayName: "Future Stars", bsc: fsB, sl: fsS, confidence: 0.9 },
      { displayName: "Stars of MLB", bsc: smB, sl: smS, confidence: 0.9 },
    ],
    unmatchedBsc: [cp],
    unmatchedSl: [black, bowman],
  };
};

type Tree = Array<{ insert: ReturnType<typeof row>; parallels: ReturnType<typeof row>[] }>;

function world(opts: { fetch?: Fetch; existing?: ReturnType<typeof row>[]; usedBsc?: string[]; tree?: Tree } = {}) {
  const fetch = opts.fetch ?? twoSided();
  return fakeNbClient({
    [LIST]: (a) => {
      if (a.level === "variantType") {
        return [
          row("vt-base", "variantType", "Base"),
          row("vt-ins", "variantType", "Insert"),
        ];
      }
      if (a.level === "insert") return opts.existing ?? [];
      return [];
    },
    "selectorOptions:getAncestorChain": () => [
      row("s1", "sport", "Baseball"),
      row("y1", "year", "2024"),
      row("m1", "manufacturer", "Topps"),
      row("set1", "setName", "Topps Chrome"),
      row("vt-ins", "variantType", "Insert"),
    ],
    "selectorOptions:getBaseVariantBySet": () => ({
      value: "Base",
      platformData: { sportlots: { s0: "884412" } },
      platformLabels: { sportlots: { s0: "Topps Chrome" } },
    }),
    "selectorOptions:getInsertTreeByVariantType": () => opts.tree ?? [],
    "setParallelConversion:getBrandSlHolders": () => ({ rows: [], truncated: false }),
    "selectorOptions:getUsedInsertIdentifiersBySet": () => ({
      values: [],
      slPlatformValues: [],
      bscPlatformValues: opts.usedBsc ?? [],
    }),
    [FETCH]: () => ({
      success: true,
      slCandidates: [],
      errors: [],
      skippedSides: fetch.pausedSides ?? [],
      pausedSides: fetch.pausedSides ?? [],
      twinIds: fetch.twinIds ?? { bsc: [], sportlots: [] },
      ...fetch,
    }),
    [STORE]: (a) => ({
      success: true,
      message: "ok",
      optionsCount: (a.reconciledItems as unknown[]).length,
      hasMore: false,
    }),
  });
}

const cleanSync = (): ReconcileSync => ({
  pairs: [
    { name: "Future Stars", bsc: ["fs"], sportlots: ["9001"] },
    { name: "Stars of MLB", bsc: ["smlb"], sportlots: ["9010"] },
  ],
  pending: [
    { side: "bsc", id: "cp", decision: "own-set" },
    { side: "sportlots", id: "9020", decision: "leave" },
    { side: "sportlots", id: "9030", decision: "leave" },
  ],
});

const opts = { at: "steps[1].variants[0]", path: "Baseball/2024/Topps/Topps Chrome" };

describe("reconcileVariants: the Reconcile dialog path", () => {
  test("a clean answer saves every named set, in pair order, with the dialog's Save payload", async () => {
    const client = world();
    const res = await reconcileVariants(client, "set1" as never, "Insert", cleanSync(), opts);
    expect(res).toMatchObject({ outcome: "saved", mode: "dialog", sent: 3, holds: null });
    const args = client.callsTo(STORE)[0].args;
    expect(args).toMatchObject({ level: "insert", parentId: "vt-ins", coveredSides: ["bsc", "sportlots"] });
    expect(args.returnedIds).toEqual({ bsc: ["fs", "smlb", "cp"], sportlots: ["9001", "9010", "9020", "9030"] });
    const items = args.reconciledItems as Array<Record<string, unknown>>;
    expect(items.map((i) => i.value)).toEqual(["Future Stars", "Stars of MLB", "Chrome Prospects"]);
    expect(items[0].platformData).toEqual({ bsc: ["fs"], sportlots: ["9001"] });
    expect(items[2]).toMatchObject({ platformData: { bsc: ["cp"] }, identityOnly: true });
    // The fetch is VariantForm's, Base SportLots label as the matching aid.
    expect(client.callsTo(FETCH)[0].args).toMatchObject({ level: "insert", parentId: "vt-ins", baseSlPrefix: "Topps Chrome" });
  });

  test("a pending set inside the dialog's SportLots filter that no decision names is open; nothing is saved", async () => {
    const client = world();
    const sync = cleanSync();
    sync.pending = sync.pending.filter((p) => p.id !== "9020"); // "Topps Chrome Black": inside the "topps chrome" filter
    const res = await reconcileVariants(client, "set1" as never, "Insert", sync, opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.reconcile.pending).toEqual([{ side: "sportlots", id: "9020", name: "Topps Chrome Black" }]);
    expect(client.callsTo(STORE)).toHaveLength(0);
  });

  test("a SportLots set outside the dialog's SportLots filter (another product of the brand-year) is left unasked and counted", async () => {
    const client = world();
    const sync = cleanSync();
    sync.pending = sync.pending.filter((p) => p.id !== "9030"); // "Bowman Chrome": the dialog hides it behind "Show all"
    const res = await reconcileVariants(client, "set1" as never, "Insert", sync, opts);
    expect(res).toMatchObject({ outcome: "saved", sent: 3, leftUnasked: { outsideScope: 1, pairedElsewhere: 0 } });
    // Save leaves it in Pending: no row carries it.
    const items = client.callsTo(STORE)[0].args.reconciledItems as Array<{ platformData: { sportlots?: string[] } }>;
    expect(items.flatMap((i) => i.platformData.sportlots ?? [])).not.toContain("9030");
  });

  test("an answered set outside the filter is still applied: the filter only decides what is ASKED", async () => {
    const client = world();
    const sync = cleanSync();
    sync.pending = sync.pending.map((p) => (p.id === "9030" ? { ...p, decision: "own-set" as const } : p));
    const res = await reconcileVariants(client, "set1" as never, "Insert", sync, opts);
    expect(res).toMatchObject({ outcome: "saved", sent: 4 });
    expect(res).not.toHaveProperty("leftUnasked");
  });

  test("with \"Show all\" on (twins on a one-sided fetch) nothing is outside the filter", async () => {
    const lone = sl("Bowman Chrome", "9030");
    const twinA = sl("Topps Chrome Future Stars", "9001");
    const twinB = sl("Topps Chrome Future Stars", "9002");
    const client = world({
      fetch: {
        bscOptions: [],
        slOptions: [twinA, twinB, lone],
        autoMatched: [],
        unmatchedBsc: [],
        unmatchedSl: [twinA, twinB, lone],
        twinIds: { bsc: [], sportlots: ["9001", "9002"] },
      },
    });
    const res = await reconcileVariants(client, "set1" as never, "Insert", { pairs: [], pending: [] }, opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.reconcile.pending.map((p) => p.id)).toEqual(["9001", "9002", "9030"]);
  });

  test("a set the spec files under another variant type is left unasked here and counted", async () => {
    const client = world();
    const sync = cleanSync();
    sync.pending = sync.pending.filter((p) => p.id !== "9020");
    const res = await reconcileVariants(client, "set1" as never, "Insert", sync, {
      ...opts,
      pairedElsewhere: { bsc: [], sportlots: ["9020"] },
    });
    expect(res).toMatchObject({ outcome: "saved", leftUnasked: { outsideScope: 0, pairedElsewhere: 1 } });
  });

  test("an auto-match the spec leaves unanswered comes back as the proposed pair", async () => {
    const client = world();
    const sync = cleanSync();
    sync.pairs = sync.pairs.filter((p) => p.name !== "Stars of MLB");
    const res = await reconcileVariants(client, "set1" as never, "Insert", sync, opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.reconcile.proposedPairs).toEqual([{ name: "Stars of MLB", buysportscards: ["smlb"], sportlots: ["9010"] }]);
    expect(res.reconcile.pending).toEqual([]);
    expect(client.callsTo(STORE)).toHaveLength(0);
  });

  test("leaving an auto-match out ON PURPOSE (both halves 'leave') is a clean answer", async () => {
    const client = world();
    const sync = cleanSync();
    sync.pairs = sync.pairs.filter((p) => p.name !== "Stars of MLB");
    sync.pending.push({ side: "bsc", id: "smlb", decision: "leave" }, { side: "sportlots", id: "9010", decision: "leave" });
    const res = await reconcileVariants(client, "set1" as never, "Insert", sync, opts);
    expect(res).toMatchObject({ outcome: "saved", sent: 2 });
  });

  test("a pair naming an id the fetch did not return is open; never matched to a neighbour", async () => {
    const client = world();
    const sync = cleanSync();
    sync.pairs[0] = { name: "Future Stars", bsc: ["fs"], sportlots: ["9999"] };
    const res = await reconcileVariants(client, "set1" as never, "Insert", sync, opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.names).toContainEqual({
      at: "steps[1].variants[0].sync.pairs[0].sportlots",
      kind: "reconcile-id",
      name: "9999",
      candidates: [],
    });
    expect(client.callsTo(STORE)).toHaveLength(0);
  });

  test("ids two saved rows carry make the pair ambiguous: nothing is saved", async () => {
    const twinRows = [
      row("r1", "insert", "Future Stars", { platformData: { bsc: { b0: "fs" }, sportlots: { s0: "9001" } } }),
      row("r2", "insert", "Future Stars II", { platformData: { bsc: { b0: "fs" }, sportlots: { s0: "9001" } } }),
    ];
    const client = world({ existing: twinRows });
    const sync = cleanSync();
    sync.pairs[0].name = "Future Stars X"; // not already saved, so the fetch runs
    const res = await reconcileVariants(client, "set1" as never, "Insert", sync, opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.names.find((n) => n.kind === "reconcile-pair")?.candidates.map((c) => c.id).sort()).toEqual(["r1", "r2"]);
    expect(client.callsTo(STORE)).toHaveLength(0);
  });

  test("a saved row no pair names is open too", async () => {
    const client = world({
      existing: [row("r9", "insert", "Old Insert", { platformData: { bsc: { b0: "old" } } })],
    });
    const res = await reconcileVariants(client, "set1" as never, "Insert", cleanSync(), opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.names).toContainEqual(
      expect.objectContaining({ kind: "reconcile-saved-row", name: "Old Insert" }),
    );
    expect(client.callsTo(STORE)).toHaveLength(0);
  });

  test("two sets saving under one name are refused the way Save refuses them", async () => {
    const client = world();
    const sync = cleanSync();
    sync.pairs[1].name = "Future Stars";
    const res = await reconcileVariants(client, "set1" as never, "Insert", sync, opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.names.map((n) => n.kind)).toContain("reconcile-title");
    expect(client.callsTo(STORE)).toHaveLength(0);
  });
});

describe("reconcileVariants: idempotency", () => {
  test("rows already carrying every pair and own-set id are skipped before any fetch", async () => {
    const client = world({
      existing: [
        row("r1", "insert", "Future Stars", { platformData: { bsc: { b0: "fs" }, sportlots: { s0: "9001" } } }),
        row("r2", "insert", "Stars of MLB", { platformData: { bsc: { b0: "smlb" }, sportlots: { s0: "9010" } } }),
        row("r3", "insert", "Chrome Prospects", { platformData: { bsc: { b0: "cp" } } }),
      ],
    });
    const res = await reconcileVariants(client, "set1" as never, "Insert", cleanSync(), opts);
    expect(res).toMatchObject({ outcome: "skipped", reason: "already-saved" });
    expect(client.callsTo(FETCH)).toHaveLength(0);
  });

  test("a clean answer that saves nothing new is not sent", async () => {
    const client = world();
    const res = await reconcileVariants(
      client,
      "set1" as never,
      "Insert",
      {
        pairs: [],
        pending: [
          ...["fs", "smlb", "cp"].map((id) => ({ side: "bsc" as const, id, decision: "leave" as const })),
          ...["9001", "9010", "9020", "9030"].map((id) => ({ side: "sportlots" as const, id, decision: "leave" as const })),
        ],
      },
      opts,
    );
    expect(res).toMatchObject({ outcome: "skipped", reason: "unchanged" });
    expect(client.callsTo(STORE)).toHaveLength(0);
  });
});

describe("reconcileVariants: rows Group Parallels moved under an insert (NEO-339 re-run)", () => {
  const ids = (b: string, s?: string) => ({ platformData: { bsc: { b0: b }, ...(s ? { sportlots: { s0: s } } : {}) } });
  const fsRow = () => row("r1", "insert", "Future Stars", ids("fs", "9001"));
  const smRow = () => row("r2", "insert", "Stars of MLB", ids("smlb", "9010"));
  const cpPar = () => row("r3", "parallel", "Chrome Prospects", ids("cp"));

  test("a grouped row carrying exactly an answer's ids is saved: skipped before any fetch", async () => {
    const smGrouped = row("r2", "parallel", "Stars of MLB", ids("smlb", "9010"));
    const client = world({ existing: [fsRow()], tree: [{ insert: fsRow(), parallels: [smGrouped, cpPar()] }] });
    const res = await reconcileVariants(client, "set1" as never, "Insert", cleanSync(), opts);
    expect(res).toMatchObject({ outcome: "skipped", reason: "already-saved", savedGrouped: 2 });
    expect(client.callsTo(FETCH)).toHaveLength(0);
    expect(client.callsTo(STORE)).toHaveLength(0);
  });

  test("the claimed answers are not handed to the dialog; the rest of the spec saves as usual", async () => {
    // Only "Chrome Prospects" (an own-set) was saved and grouped; the two pairs are new.
    const client = world({ existing: [], tree: [{ insert: row("x", "insert", "Other", ids("other")), parallels: [cpPar()] }] });
    const res = await reconcileVariants(client, "set1" as never, "Insert", cleanSync(), opts);
    expect(res).toMatchObject({ outcome: "saved", mode: "dialog", sent: 2, savedGrouped: 1 });
    const items = client.callsTo(STORE)[0].args.reconciledItems as Array<{ value: string }>;
    expect(items.map((i) => i.value)).toEqual(["Future Stars", "Stars of MLB"]);
  });

  test("a grouped row holding only SOME of a pair's ids claims nothing: still the open id it was", async () => {
    const partial = row("r2", "parallel", "Stars of MLB", ids("smlb", "9099"));
    const client = world({ existing: [fsRow()], tree: [{ insert: fsRow(), parallels: [partial, cpPar()] }] });
    const res = await reconcileVariants(client, "set1" as never, "Insert", cleanSync(), opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.names).toContainEqual({ at: "steps[1].variants[0].sync.pairs[1].bsc", kind: "reconcile-id", name: "smlb", candidates: [] });
    expect(client.callsTo(STORE)).toHaveLength(0);
  });

  test("a grouped row and a top-level row carrying the same exact ids are a tie, asked once with both", async () => {
    const twin = row("r9", "parallel", "Stars of MLB II", ids("smlb", "9010"));
    const client = world({ existing: [fsRow(), smRow()], tree: [{ insert: fsRow(), parallels: [twin, cpPar()] }, { insert: smRow(), parallels: [] }] });
    const res = await reconcileVariants(client, "set1" as never, "Insert", cleanSync(), opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    const at = "steps[1].variants[0].sync.pairs[1]";
    expect(res.names.filter((n) => n.at === at || n.at.startsWith(`${at}.`))).toEqual([
      {
        at,
        kind: "reconcile-pair",
        name: "Stars of MLB",
        candidates: [
          { id: "r2", name: "Stars of MLB", detail: "insert" },
          { id: "r9", name: "Stars of MLB II", detail: "parallel of Future Stars" },
        ],
      },
    ]);
    expect(client.callsTo(STORE)).toHaveLength(0);
  });

  test("two grouped rows carrying the same exact ids are a tie too: no bare missing-id decision beside it", async () => {
    const a = row("g1", "parallel", "Stars of MLB", ids("smlb", "9010"));
    const b = row("g2", "parallel", "Stars of MLB Gold", ids("smlb", "9010"));
    const client = world({ existing: [fsRow()], tree: [{ insert: fsRow(), parallels: [a, b, cpPar()] }] });
    const res = await reconcileVariants(client, "set1" as never, "Insert", cleanSync(), opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.names).toEqual([
      expect.objectContaining({
        at: "steps[1].variants[0].sync.pairs[1]",
        kind: "reconcile-pair",
        candidates: [expect.objectContaining({ id: "g1" }), expect.objectContaining({ id: "g2" })],
      }),
    ]);
  });
});

describe("reconcileVariants: the single-platform path", () => {
  const bscOnly = (): Fetch => ({
    bscOptions: [bsc("Future Stars", "fs"), bsc("Chrome Prospects", "cp"), bsc("Moved Elsewhere", "mv")],
    slOptions: [],
    autoMatched: [],
    unmatchedBsc: [bsc("Future Stars", "fs"), bsc("Chrome Prospects", "cp"), bsc("Moved Elsewhere", "mv")],
    unmatchedSl: [],
    pausedSides: ["sportlots"],
  });

  test("paused SportLots: every unheld BSC set is stored as the form does, and the spec is not consulted", async () => {
    const client = world({ fetch: bscOnly(), usedBsc: ["mv"] });
    const res = await reconcileVariants(client, "set1" as never, "Insert", cleanSync(), {
      ...opts,
      paused: parseDeclaredPaused("sportlots"),
    });
    expect(res).toMatchObject({ outcome: "saved", mode: "single-platform", sent: 2, specNotConsulted: true });
    const args = client.callsTo(STORE)[0].args;
    expect(args.reconciledItems).toEqual([
      { value: "Future Stars", platformData: { bsc: "fs" } },
      { value: "Chrome Prospects", platformData: { bsc: "cp" } },
    ]);
    expect(args.coveredSides).toEqual(["bsc"]);
  });

  test("a name twin among them opens Reconcile instead, which needs the spec's answers", async () => {
    const fetch = bscOnly();
    fetch.twinIds = { bsc: ["fs"], sportlots: [] };
    const client = world({ fetch, usedBsc: ["mv"] });
    const res = await reconcileVariants(client, "set1" as never, "Insert", { pairs: [], pending: [] }, {
      ...opts,
      paused: parseDeclaredPaused("sportlots"),
    });
    expect(res.outcome).toBe("open");
    expect(client.callsTo(STORE)).toHaveLength(0);
  });

  test("a failed fetch writes nothing", async () => {
    const client = world();
    client.on(FETCH, () => ({
      success: false,
      bscOptions: [],
      slOptions: [],
      autoMatched: [],
      unmatchedBsc: [],
      unmatchedSl: [],
      slCandidates: [],
      errors: [{ platform: "sportlots", message: "<html>raw adapter text</html>" }],
      skippedSides: [],
      pausedSides: [],
      twinIds: { bsc: [], sportlots: [] },
    }));
    const err = await reconcileVariants(client, "set1" as never, "Insert", cleanSync(), opts).catch((e) => e);
    expect(err).toBeInstanceOf(ReconcileFetchError);
    expect(String(err.message)).not.toContain("raw adapter text");
    expect(client.callsTo(STORE)).toHaveLength(0);
  });
});

test("the Base is refused: it is mapped, not synced", async () => {
  // NEO-334: the type titled Base IS the Base; no flag says so.
  const client = world();
  await expect(reconcileVariants(client, "set1" as never, "Base", cleanSync(), opts)).rejects.toThrow(/Base/);
});

describe("splitMootLeaves (NEO-339: a leave with nothing to leave)", () => {
  const outcome = (unmatchedPending: Array<{ entry: { side: "bsc" | "sportlots"; id: string; decision: "own-set" | "leave" }; reason: "not-in-fetch" | "not-pending" }>) => ({
    state: { ready: [], pendingBsc: [], pendingSl: [], seq: 0 },
    unmatchedPairs: [],
    ambiguousPairs: [],
    unmatchedPending,
    unaddressedPending: [],
    unaddressedReady: [],
    disbanded: [],
  });

  test("only a leave the dialog no longer shows is moot: held (still fetched) or not listed", () => {
    const held = { entry: { side: "sportlots" as const, id: "sl-held", decision: "leave" as const }, reason: "not-in-fetch" as const };
    const gone = { entry: { side: "bsc" as const, id: "bsc-gone", decision: "leave" as const }, reason: "not-in-fetch" as const };
    const ownSet = { entry: { side: "sportlots" as const, id: "sl-held-2", decision: "own-set" as const }, reason: "not-in-fetch" as const };
    const paired = { entry: { side: "sportlots" as const, id: "sl-paired", decision: "leave" as const }, reason: "not-pending" as const };
    const r = splitMootLeaves(outcome([held, gone, ownSet, paired]), {
      bsc: new Set<string>(),
      sportlots: new Set(["sl-held", "sl-held-2", "sl-paired"]),
    });
    expect(r.moot).toEqual([
      { side: "sportlots", id: "sl-held", why: "held" },
      { side: "bsc", id: "bsc-gone", why: "not-listed" },
    ]);
    // An own-set for a set it cannot make, and a leave for a set the spec also pairs, stay open.
    expect(r.outcome.unmatchedPending).toEqual([ownSet, paired]);
  });
});
