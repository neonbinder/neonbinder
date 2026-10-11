import { describe, expect, test } from "vitest";
import { convexCodeError, fakeNbClient, row } from "./fake-nb-client";
import { confirmMapping, currentBaseMapping, NoBaseVariantType } from "./map-base";
import { parseDeclaredPaused, PausedMismatch } from "./sync-column";

const LIST = "selectorOptions:getSelectorOptions";
const CHAIN = "selectorOptions:getAncestorChain";
const FETCH = "setReconciliation:fetchRawOptions";
const WRITE = "selectorOptions:setVariantTypePlatformData";

const unmappedBase = () =>
  row("vt-base", "variantType", "Base", {
    metadata: { isBase: true },
    platformData: { bsc: { b0: "base" } },
    platformFacets: { bsc: { b0: "variant" } },
    lastUpdated: 5,
  });

const mappedBase = () =>
  row("vt-base", "variantType", "Base", {
    metadata: { isBase: true },
    platformData: { bsc: { b0: "base", b1: "2024-topps-chrome" }, sportlots: { s0: "884412" } },
    platformFacets: { bsc: { b0: "variant", b1: "setName" } },
    lastUpdated: 9,
  });

function world(opts: {
  base?: () => ReturnType<typeof row>;
  pausedSides?: string[];
  writes?: Array<() => unknown>;
} = {}) {
  let base = (opts.base ?? unmappedBase)();
  const writes = [...(opts.writes ?? [])];
  return fakeNbClient({
    [LIST]: (a) =>
      a.level === "variantType"
        ? [row("vt-ins", "variantType", "Insert", { metadata: { variantRole: "insert" } }), base]
        : [],
    [CHAIN]: () => [
      row("s1", "sport", "Baseball"),
      row("y1", "year", "2024"),
      row("m1", "manufacturer", "Topps"),
      row("set1", "setName", "Topps Chrome", { platformData: { bsc: { b0: "2024-topps-chrome-set" } } }),
      base,
    ],
    [FETCH]: () => ({
      success: true,
      bscOptions: [{ value: "Topps Chrome", platformValue: "2024-topps-chrome" }],
      slOptions: [
        { value: "Topps Chrome", platformValue: "884412" },
        { value: "Topps Chrome Update", platformValue: "884999" },
      ],
      autoMatched: [],
      unmatchedBsc: [],
      unmatchedSl: [],
      slCandidates: [],
      errors: [],
      skippedSides: opts.pausedSides ?? [],
      pausedSides: opts.pausedSides ?? [],
      twinIds: { bsc: [], sportlots: [] },
    }),
    [WRITE]: () => {
      const next = writes.shift();
      if (next) return next();
      base = mappedBase();
      return { success: true, message: "Stored Base mapping" };
    },
  });
}

const both = { bsc: "2024-topps-chrome", sportlots: "884412", whenPaused: "bsc-only" as const };

describe("confirmMapping", () => {
  test("writes exactly the named ids with the row's version, through the dialog's payload", async () => {
    const client = world();
    const res = await confirmMapping(client, "set1" as never, both);
    expect(res).toMatchObject({ outcome: "mapped", sides: { bsc: "2024-topps-chrome", sportlots: "884412" } });
    expect(client.callsTo(WRITE)[0].args).toEqual({
      variantTypeId: "vt-base",
      platformData: { bsc: "2024-topps-chrome", sportlots: "884412", sportlotsDisplay: "Topps Chrome" },
      bscLabel: "Topps Chrome",
      baseVersion: 5,
    });
    // The fetch is the Base's, with BaseMappingForm's parentFilters.
    expect(client.callsTo(FETCH)[0].args).toMatchObject({
      level: "insert",
      parentId: "vt-base",
      parentFilters: { sport: "Baseball", year: "2024", manufacturer: "Topps", setName: "Topps Chrome", variantType: "Base" },
    });
  });

  test("already mapped to the same ids: skipped with no marketplace call", async () => {
    const client = world({ base: mappedBase });
    const res = await confirmMapping(client, "set1" as never, both);
    expect(res).toMatchObject({ outcome: "skipped", reason: "already-mapped" });
    expect(client.callsTo(FETCH)).toHaveLength(0);
    expect(client.callsTo(WRITE)).toHaveLength(0);
  });

  test("an id the fetch did not offer is an open decision listing the candidates; nothing is written", async () => {
    const client = world();
    const res = await confirmMapping(client, "set1" as never, { ...both, sportlots: "123" }, {
      at: "steps[1].base.map",
      path: "Baseball/2024/Topps/Topps Chrome",
    });
    expect(res.outcome).toBe("open");
    if (res.outcome !== "open") return;
    expect(res.open).toEqual([
      {
        at: "steps[1].base.map.sportlots",
        path: "Baseball/2024/Topps/Topps Chrome",
        side: "sportlots",
        candidates: [
          { id: "884412", name: "Topps Chrome", score: 1000 },
          { id: "884999", name: "Topps Chrome Update", score: expect.any(Number) },
        ],
      },
    ]);
    expect(client.callsTo(WRITE)).toHaveLength(0);
  });

  test("the set listing is an offered BSC candidate like any other", async () => {
    const client = world();
    const res = await confirmMapping(client, "set1" as never, { bsc: "2024-topps-chrome-set", whenPaused: "skip" });
    expect(res.outcome).toBe("mapped");
    expect(client.callsTo(WRITE)[0].args.platformData).toEqual({ bsc: "2024-topps-chrome-set" });
  });

  test("paused SportLots + bsc-only maps BSC alone", async () => {
    const client = world({ pausedSides: ["sportlots"] });
    const res = await confirmMapping(client, "set1" as never, both, { paused: parseDeclaredPaused("sportlots") });
    expect(res).toMatchObject({ outcome: "mapped", sides: { bsc: "2024-topps-chrome" } });
    expect(client.callsTo(WRITE)[0].args.platformData).toEqual({ bsc: "2024-topps-chrome" });
  });

  test("paused SportLots + skip maps nothing and fetches nothing", async () => {
    const client = world({ pausedSides: ["sportlots"] });
    const res = await confirmMapping(client, "set1" as never, { ...both, whenPaused: "skip" }, {
      paused: parseDeclaredPaused("sportlots"),
    });
    expect(res).toMatchObject({ outcome: "skipped", reason: "paused", pausedSides: ["sportlots"] });
    expect(client.calls).toHaveLength(0);
  });

  test("a fetch reporting a pause the run did not declare stops it", async () => {
    const client = world({ pausedSides: ["sportlots"] });
    await expect(
      confirmMapping(client, "set1" as never, both, { paused: parseDeclaredPaused(undefined) }),
    ).rejects.toBeInstanceOf(PausedMismatch);
    expect(client.callsTo(WRITE)).toHaveLength(0);
  });

  test("BASE_MAPPING_STALE is retried once on a fresh read; a second one throws", async () => {
    const once = world({
      writes: [
        () => {
          throw convexCodeError("BASE_MAPPING_STALE");
        },
      ],
    });
    const res = await confirmMapping(once, "set1" as never, both);
    expect(res).toMatchObject({ outcome: "mapped", retriedStale: true });
    expect(once.callsTo(FETCH)).toHaveLength(2);

    const stale = () => {
      throw convexCodeError("BASE_MAPPING_STALE");
    };
    const twice = world({ writes: [stale, stale] });
    await expect(confirmMapping(twice, "set1" as never, both)).rejects.toMatchObject({ data: { code: "BASE_MAPPING_STALE" } });
    expect(twice.callsTo(WRITE)).toHaveLength(2);
  });

  test("a set with no Base role row refuses before any fetch", async () => {
    const client = fakeNbClient({ [LIST]: () => [row("vt", "variantType", "Base")] });
    await expect(confirmMapping(client, "set1" as never, both)).rejects.toBeInstanceOf(NoBaseVariantType);
  });
});

describe("currentBaseMapping", () => {
  test("reads the setName-tagged BSC slot, never the variant one", () => {
    expect(currentBaseMapping(mappedBase() as never)).toEqual({ bsc: "2024-topps-chrome", sportlots: "884412" });
    expect(currentBaseMapping(unmappedBase() as never)).toEqual({});
  });
});
