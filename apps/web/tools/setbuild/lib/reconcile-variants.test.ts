import { describe, expect, test } from "vitest";
import { fakeNbClient, row } from "./fake-nb-client";
import { reconcileVariants, ReconcileFetchError } from "./reconcile-variants";
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

function world(opts: { fetch?: Fetch; existing?: ReturnType<typeof row>[]; usedBsc?: string[]; typeRole?: "base" } = {}) {
  const fetch = opts.fetch ?? twoSided();
  return fakeNbClient({
    [LIST]: (a) => {
      if (a.level === "variantType") {
        return [
          row("vt-base", "variantType", "Base", { metadata: { isBase: true } }),
          row("vt-ins", "variantType", "Insert", {
            metadata: opts.typeRole === "base" ? { isBase: true } : { variantRole: "insert" },
          }),
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
    "selectorOptions:getInsertTreeByVariantType": () => [],
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

  test("a pending set no decision names is open, even one the dialog hides by default; nothing is saved", async () => {
    const client = world();
    const sync = cleanSync();
    sync.pending = sync.pending.filter((p) => p.id !== "9030"); // "Bowman Chrome": outside the prefix view
    const res = await reconcileVariants(client, "set1" as never, "Insert", sync, opts);
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.reconcile.pending).toEqual([{ side: "sportlots", id: "9030", name: "Bowman Chrome" }]);
    expect(client.callsTo(STORE)).toHaveLength(0);
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
  const client = world({ typeRole: "base" });
  await expect(reconcileVariants(client, "set1" as never, "Insert", cleanSync(), opts)).rejects.toThrow(/Base/);
});
