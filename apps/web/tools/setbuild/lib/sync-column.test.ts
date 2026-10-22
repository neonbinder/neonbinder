import { describe, expect, test } from "vitest";
import { ResolveError } from "../spec/resolve";
import { convexCodeError, fakeNbClient, row, type Handler } from "./fake-nb-client";
import {
  AddRowRefused,
  addRow,
  checkPausedPlatforms,
  ColumnSyncError,
  ensureBrandYearPath,
  ensureColumn,
  NOTHING_PAUSED,
  parseDeclaredPaused,
  PausedMismatch,
} from "./sync-column";

const ENSURE = "selectorOptions:ensureSelectorOptions";
const STATUS = "selectorOptions:getSelectorSyncStatus";
const LIST = "selectorOptions:getSelectorOptions";

const synced = (extra: Record<string, unknown> = {}) => ({
  ran: true,
  reason: "synced",
  skippedSides: [],
  pausedSides: [],
  ...extra,
});

describe("checkPausedPlatforms", () => {
  test("agreement returns the declared pause as sites and sides", async () => {
    const client = fakeNbClient({ "marketplacePause:getPausedPlatforms": () => ["sportlots"] });
    const ctx = await checkPausedPlatforms(client, " SportLots ");
    expect([...ctx.sites]).toEqual(["sportlots"]);
    expect([...ctx.sides]).toEqual(["sportlots"]);
  });

  test("a disagreement in either direction fails loudly", async () => {
    const paused = fakeNbClient({ "marketplacePause:getPausedPlatforms": () => ["sportlots"] });
    await expect(checkPausedPlatforms(paused, undefined)).rejects.toBeInstanceOf(PausedMismatch);
    const live = fakeNbClient({ "marketplacePause:getPausedPlatforms": () => [] });
    await expect(checkPausedPlatforms(live, "sportlots")).rejects.toBeInstanceOf(PausedMismatch);
  });

  test("an unknown declared key is refused, not dropped", () => {
    expect(() => parseDeclaredPaused("sportlot")).toThrow(/unknown platform/);
  });
});

describe("ensureColumn", () => {
  test("a populated column is skipped without asking the server to sync", async () => {
    const client = fakeNbClient({ [LIST]: () => [row("s1", "sport", "Baseball")] });
    const res = await ensureColumn(client, "sport", undefined);
    expect(res.outcome).toBe("skipped");
    expect(client.callsTo(ENSURE)).toHaveLength(0);
  });

  test("an empty column runs ensureSelectorOptions, waits out the status, and re-reads", async () => {
    let rows: ReturnType<typeof row>[] = [];
    const client = fakeNbClient({
      [LIST]: () => rows,
      [ENSURE]: () => {
        rows = [row("y1", "year", "2024")];
        return synced();
      },
      [STATUS]: () => ({ status: "done", message: "BuySportsCards skipped." }),
    });
    const res = await ensureColumn(client, "year", "s1" as never);
    expect(res).toMatchObject({ outcome: "synced", notice: "BuySportsCards skipped." });
    expect(res.rows).toHaveLength(1);
    expect(client.callsTo(ENSURE)[0].args).toEqual({ level: "year", parentId: "s1" });
  });

  test("an error status is a ColumnSyncError carrying the server's safe message", async () => {
    const client = fakeNbClient({
      [LIST]: () => [],
      [ENSURE]: () => synced({ reason: "error" }),
      [STATUS]: () => ({ status: "error", message: "Sync failed." }),
    });
    await expect(ensureColumn(client, "sport", undefined)).rejects.toThrow(ColumnSyncError);
  });

  test("a paused side the run did not declare stops the run", async () => {
    const client = fakeNbClient({
      [LIST]: () => [],
      [ENSURE]: () => synced({ ran: false, reason: "paused", pausedSides: ["sportlots"] }),
      [STATUS]: () => null,
    });
    await expect(ensureColumn(client, "manufacturer", "y1" as never, { paused: NOTHING_PAUSED })).rejects.toBeInstanceOf(
      PausedMismatch,
    );
  });
});

describe("addRow (+ Custom)", () => {
  test("an existing row of that name is returned and nothing is written", async () => {
    const client = fakeNbClient({ [LIST]: () => [row("m1", "manufacturer", "Bowman")] });
    expect(await addRow(client, "manufacturer", "y1" as never, "bowman")).toEqual({ id: "m1", created: false });
    expect(client.callsTo("selectorOptions:addCustomSelectorOption")).toHaveLength(0);
  });

  test("a missing row is added through addCustomSelectorOption", async () => {
    const client = fakeNbClient({
      [LIST]: () => [],
      "selectorOptions:addCustomSelectorOption": () => "m9",
    });
    expect(await addRow(client, "manufacturer", "y1" as never, "Bowman")).toEqual({ id: "m9", created: true });
  });

  test("two rows of that name are ambiguous: nothing is written", async () => {
    const client = fakeNbClient({ [LIST]: () => [row("a", "insert", "Anime"), row("b", "insert", "Anime")] });
    await expect(addRow(client, "insert", "v1" as never, "Anime")).rejects.toBeInstanceOf(ResolveError);
    expect(client.callsTo("selectorOptions:addCustomSelectorOption")).toHaveLength(0);
  });

  test("a server refusal keeps its code", async () => {
    const client = fakeNbClient({
      [LIST]: () => [],
      "selectorOptions:addCustomSelectorOption": () => {
        throw convexCodeError("CUSTOM_EXISTS_ELSEWHERE");
      },
    });
    await expect(addRow(client, "manufacturer", "y1" as never, "Bowman")).rejects.toMatchObject({
      name: "AddRowRefused",
      code: "CUSTOM_EXISTS_ELSEWHERE",
    });
    expect(AddRowRefused).toBeDefined();
  });
});

describe("ensureBrandYearPath", () => {
  function world(opts: { manufacturerSynced: boolean }) {
    let manufacturers: ReturnType<typeof row>[] = [];
    const handlers: Record<string, Handler> = {
      [LIST]: (a) => {
        if (a.level === "sport") return [row("s1", "sport", "Baseball")];
        if (a.level === "year") return [row("y1", "year", "2026")];
        return manufacturers;
      },
      [ENSURE]: () => {
        if (opts.manufacturerSynced) manufacturers = [row("m1", "manufacturer", "Bowman")];
        return opts.manufacturerSynced
          ? synced()
          : { ran: false, reason: "paused", skippedSides: ["bsc", "sportlots"], pausedSides: ["sportlots"] };
      },
      [STATUS]: () => null,
      "selectorOptions:addCustomSelectorOption": () => {
        manufacturers = [row("m2", "manufacturer", "Bowman")];
        return "m2";
      },
    };
    return fakeNbClient(handlers);
  }
  const path = { sport: "Baseball", year: "2026", manufacturer: "Bowman" };
  const slPaused = parseDeclaredPaused("sportlots");

  test("live: the synced manufacturer resolves and nothing is added", async () => {
    const client = world({ manufacturerSynced: true });
    const r = await ensureBrandYearPath(client, path, { manufacturer: { whenMissing: "create" } });
    expect(r).toMatchObject({ manufacturerId: "m1", manufacturerCreated: false });
    expect(client.callsTo("selectorOptions:addCustomSelectorOption")).toHaveLength(0);
  });

  test("paused: whenMissing create adds it through + Custom", async () => {
    const client = world({ manufacturerSynced: false });
    const r = await ensureBrandYearPath(client, path, { paused: slPaused, manufacturer: { whenMissing: "create" } });
    expect(r).toMatchObject({ manufacturerId: "m2", manufacturerCreated: true });
  });

  test("paused: whenMissing fail (or no policy) stops on the missing name", async () => {
    const client = world({ manufacturerSynced: false });
    await expect(
      ensureBrandYearPath(client, path, { paused: slPaused, manufacturer: { whenMissing: "fail" } }),
    ).rejects.toBeInstanceOf(ResolveError);
    await expect(ensureBrandYearPath(world({ manufacturerSynced: false }), path, { paused: slPaused })).rejects.toBeInstanceOf(
      ResolveError,
    );
  });
});
