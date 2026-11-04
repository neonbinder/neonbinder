/**
 * NEO-427 — a scanned pair's photos onto the saved copy (`convex/intakePhotos.ts`):
 * both sides go to R2 and live, a repeat fills only what is missing, a photo
 * the collector added stays, and every failure ends on the row, never on the
 * save.
 *
 * The preprocess service and R2 are a stubbed `fetch`; the copy rows are real.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { intakePhotoPool } from "./intakePhotoPool";
import { REATTACH_CONFIRM_PHRASE, REATTACH_ENV_FLAG } from "./intakePhotos";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const OWNER = "user_scannerOwner1";
const JOB = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const FRONT = 6;
const BACK = 7;

const reattach = { confirm: REATTACH_CONFIRM_PHRASE } as const;

type Derive = (entryIndex: number) => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const gone = () => json(404, { error_code: "OUTPUT_NOT_FOUND", detail: "no processed image at this index" });
const derived = (entryIndex: number) =>
  json(200, {
    image: Buffer.from(`image-${entryIndex}`).toString("base64"),
    thumb: Buffer.from(`thumb-${entryIndex}`).toString("base64"),
    content_type: "image/jpeg",
  });

/** What reached each outside service. */
let derives: Array<{ job_id: string; user_id: string; entry_index: number }>;
let puts: Array<{ key: string; body: string; contentType: string | null }>;
let onDerive: Derive;
let onPut: (key: string) => Response | Promise<Response>;

beforeEach(() => {
  derives = [];
  puts = [];
  onDerive = derived;
  onPut = () => new Response(null, { status: 200 });
  vi.stubEnv("NEONBINDER_PREPROCESS_URL", "http://localhost:8081");
  vi.stubEnv("NEONBINDER_PREPROCESS_FAST_URL", "");
  vi.stubEnv("R2_ENDPOINT", "https://acct.r2.example");
  vi.stubEnv("R2_BUCKET", "photos");
  vi.stubEnv("R2_ACCESS_KEY_ID", "AKIDEXAMPLE");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
  vi.stubEnv(REATTACH_ENV_FLAG, "true");
  // convex-test can't mount the workpool: a test runs the attach itself.
  vi.spyOn(intakePhotoPool, "enqueueAction").mockResolvedValue("work" as never);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  // Scheduled functions stay parked; the retry waits (2s, 8s) pass at once.
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const parked = globalThis.setTimeout;
  vi.stubGlobal("setTimeout", ((fn: () => void, ms?: number) => {
    if (ms === 2_000 || ms === 8_000) {
      fn();
      return 0;
    }
    return parked(fn, ms);
  }) as unknown as typeof setTimeout);
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/derive-copy-photos") {
      const body = (await request.json()) as (typeof derives)[number];
      derives.push(body);
      return onDerive(body.entry_index);
    }
    expect(request.method).toBe("PUT");
    const key = decodeURIComponent(url.pathname.replace(/^\/photos\//, ""));
    puts.push({ key, body: await request.text(), contentType: request.headers.get("content-type") });
    return await onPut(key);
  }) as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function world(opts: { saved?: boolean; photos?: "pending" | "failed" } = {}) {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const me = t.withIdentity({ subject: OWNER });
  const { copyId } = await me.mutation(api.collection.addLineItem, {
    cardId: fx.gooden1,
    details: { quantity: 1 },
  });
  const matchId = await t.run(async (ctx) => {
    const copy = await ctx.db.get(copyId);
    const now = Date.now();
    const runId = await ctx.db.insert("intakeRuns", {
      userId: OWNER,
      jobId: JOB,
      homeId: copy!.homeId,
      createdAt: now,
      lastActivityAt: now,
    });
    const pairId = await ctx.db.insert("placeholderPairs", {
      jobId: JOB,
      userId: OWNER,
      frontIndex: FRONT,
      backIndex: BACK,
      confidence: "exact",
      mechanism: "adjacency",
      score: 1,
    });
    return await ctx.db.insert("intakeMatches", {
      runId,
      userId: OWNER,
      pairId,
      frontIndex: FRONT,
      backIndex: BACK,
      readKey: "",
      confidence: 1,
      band: "matched",
      reason: "numberAndPlayer",
      candidates: [],
      variations: [],
      ...(opts.saved === false ? {} : { savedCopyId: copyId, savedQuantity: 1, savedAt: now }),
      ...(opts.photos ? { photos: opts.photos } : {}),
    });
  });
  const row = () => t.run(async (ctx) => await ctx.db.get(matchId));
  const photos = () =>
    t.run(async (ctx) =>
      (await ctx.db.query("collectionCopyPhotos").collect()).sort((a, b) => a.side.localeCompare(b.side)),
    );
  const copy = () => t.run(async (ctx) => await ctx.db.get(copyId));
  const attach = () => t.action(internal.intakePhotos.attachIntakePhotos, { matchId });
  /** A photo the collector added by hand. */
  const handPhoto = async (side: "front" | "back") => {
    const { photoId } = await t.mutation(internal.copyPhotos.reserveUpload, {
      ownerId: OWNER,
      copyId,
      side,
      contentType: "image/webp",
      imageBytes: 100,
      thumbBytes: 10,
    });
    await t.mutation(internal.copyPhotos.commitUpload, { ownerId: OWNER, photoId });
    return photoId;
  };
  return { t, me, copyId, matchId, row, photos, copy, attach, handPhoto };
}

describe("attachIntakePhotos", () => {
  test("both sides go to R2 in both sizes and go live on the copy", async () => {
    const w = await world({ photos: "pending" });
    await w.attach();

    expect(derives).toEqual([
      { job_id: JOB, user_id: OWNER, entry_index: FRONT },
      { job_id: JOB, user_id: OWNER, entry_index: BACK },
    ]);
    const rows = await w.photos();
    expect(rows.map((r) => [r.side, r.status, r.source])).toEqual([
      ["back", "live", "intake"],
      ["front", "live", "intake"],
    ]);
    const front = rows[1];
    expect(front.imageBytes).toBe(`image-${FRONT}`.length);
    expect(front.thumbBytes).toBe(`thumb-${FRONT}`.length);
    expect(puts).toContainEqual({
      key: `copy-photos/${front.token}/image.jpg`,
      body: `image-${FRONT}`,
      contentType: "image/jpeg",
    });
    expect(puts).toContainEqual({
      key: `copy-photos/${front.token}/thumb.jpg`,
      body: `thumb-${FRONT}`,
      contentType: "image/jpeg",
    });
    expect(puts).toHaveLength(4);
    expect((await w.copy())?.hasPhotos).toBe(true);
    const row = await w.row();
    expect(row?.photos).toBe("attached");
    expect(row?.photoFailure).toBeUndefined();
  });

  test("running again changes nothing and asks the service for nothing", async () => {
    const w = await world();
    await w.attach();
    const before = await w.photos();
    derives = [];
    puts = [];
    await w.attach();
    expect(derives).toEqual([]);
    expect(puts).toEqual([]);
    expect((await w.photos()).map((r) => r._id)).toEqual(before.map((r) => r._id));
    expect((await w.row())?.photos).toBe("attached");
  });

  test("a side the collector already photographed is left alone", async () => {
    const w = await world();
    const hand = await w.handPhoto("front");
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([BACK]);
    const rows = await w.photos();
    expect(rows.find((r) => r.side === "front")).toMatchObject({ _id: hand, status: "live" });
    expect(rows.find((r) => r.side === "back")).toMatchObject({ status: "live", source: "intake" });
    expect((await w.row())?.photos).toBe("attached");
  });

  test("a hand photo arriving mid-attach stands; the scan's row is left for the sweep", async () => {
    const w = await world();
    let hand: Id<"collectionCopyPhotos"> | undefined;
    onPut = async (key) => {
      // The front's thumb is the attach's last step before its check.
      if (puts.length === 2) hand = await w.handPhoto("front");
      expect(key).toContain("copy-photos/");
      return new Response(null, { status: 200 });
    };
    await w.attach();
    const fronts = (await w.photos()).filter((r) => r.side === "front");
    expect(hand).toBeDefined();
    expect(fronts.find((r) => r._id === hand)?.status).toBe("live");
    expect(fronts.find((r) => r._id !== hand)).toMatchObject({ status: "pending", source: "intake" });
    expect((await w.row())?.photos).toBe("attached");
  });

  test("scans the bucket has expired say so, and nothing is reserved", async () => {
    const w = await world({ photos: "pending" });
    onDerive = gone;
    await w.attach();
    expect(derives).toHaveLength(2); // terminal: no retries
    expect(await w.photos()).toEqual([]);
    expect(puts).toEqual([]);
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "scanGone" });
    expect(await w.copy()).toMatchObject({ quantity: 1 });
  });

  test("one side gone keeps the side that made it", async () => {
    const w = await world();
    onDerive = (entryIndex) => (entryIndex === BACK ? gone() : derived(entryIndex));
    await w.attach();
    expect((await w.photos()).map((r) => [r.side, r.status])).toEqual([["front", "live"]]);
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "scanGone" });
    expect((await w.copy())?.hasPhotos).toBe(true);
  });

  test("a 404 with no code (a revision without the route) is not a gone scan", async () => {
    const w = await world();
    onDerive = () => new Response("Not Found", { status: 404 });
    await w.attach();
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "error" });
  });

  test("a failure Try again could fix outranks a gone scan", async () => {
    const w = await world();
    onDerive = (entryIndex) => (entryIndex === BACK ? gone() : json(503, {}));
    await w.attach();
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "error" });
  });

  test.each(["PHOTO_TOO_LARGE", "OUTPUT_TOO_MANY_PIXELS", "OUTPUT_UNDECODABLE"])(
    "a scan the service can never use (%s) says unusable, after one ask",
    async (code) => {
      const w = await world({ photos: "pending" });
      onDerive = () => json(code === "OUTPUT_TOO_MANY_PIXELS" ? 413 : 422, { error_code: code });
      await w.attach();
      expect(derives).toHaveLength(2);
      expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "unusable" });
    },
  );

  test("a photo the collector removed does not come back, and the row stays attached", async () => {
    const w = await world();
    await w.attach();
    expect((await w.row())?.photoSidesAttached).toEqual(["front", "back"]);
    await w.me.mutation(api.copyPhotos.remove, { copyId: w.copyId, side: "front" });
    derives = [];
    puts = [];
    await w.attach();
    expect(derives).toEqual([]);
    expect(puts).toEqual([]);
    expect((await w.photos()).map((r) => r.side)).toEqual(["back"]);
    expect((await w.row())?.photos).toBe("attached");
  });

  test("a side removed after a partial attach stays removed while Try again fetches the other", async () => {
    const w = await world();
    onDerive = (entryIndex) => (entryIndex === BACK ? json(503, {}) : derived(entryIndex));
    await w.attach();
    expect((await w.row())?.photoSidesAttached).toEqual(["front"]);
    await w.me.mutation(api.copyPhotos.remove, { copyId: w.copyId, side: "front" });
    derives = [];
    onDerive = derived;
    await w.me.action(api.intakePhotos.retryIntakePhotos, { matchId: w.matchId });
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([BACK]);
    expect((await w.photos()).map((r) => r.side)).toEqual(["back"]);
  });

  test("a busy service gets two more tries, then the row says failed", async () => {
    const w = await world();
    const tries = new Map<number, number>();
    onDerive = (entryIndex) => {
      tries.set(entryIndex, (tries.get(entryIndex) ?? 0) + 1);
      return entryIndex === FRONT && tries.get(entryIndex)! < 3 ? json(429, {}) : derived(entryIndex);
    };
    await w.attach();
    expect(tries.get(FRONT)).toBe(3);
    expect((await w.row())?.photos).toBe("attached");

    const down = await world();
    derives = [];
    onDerive = () => json(503, {});
    await down.attach();
    expect(derives).toHaveLength(6);
    expect(await down.row()).toMatchObject({ photos: "failed", photoFailure: "error" });
    expect(await down.photos()).toEqual([]);
  });

  test("a failed PUT leaves the copy as it was and the upload pending for the sweep", async () => {
    const w = await world();
    onPut = () => new Response("denied", { status: 403 });
    await w.attach();
    expect((await w.photos()).map((r) => r.status)).toEqual(["pending", "pending"]);
    expect((await w.copy())?.hasPhotos).toBeUndefined();
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "error" });
  });

  test("R2 not set up fails the row without asking the service", async () => {
    const w = await world();
    vi.stubEnv("R2_BUCKET", "");
    await w.attach();
    expect(derives).toEqual([]);
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "error" });
  });

  test("a row never saved has nowhere to go: nothing runs and nothing is recorded", async () => {
    const w = await world({ saved: false });
    await w.attach();
    expect(derives).toEqual([]);
    expect((await w.row())?.photos).toBeUndefined();
  });
});

describe("retryIntakePhotos", () => {
  test("a failed row goes back through and fills only what is missing", async () => {
    const w = await world();
    onDerive = (entryIndex) => (entryIndex === BACK ? json(422, {}) : derived(entryIndex));
    await w.attach();
    expect((await w.row())?.photos).toBe("failed");

    derives = [];
    onDerive = derived;
    await w.me.action(api.intakePhotos.retryIntakePhotos, { matchId: w.matchId });
    expect(derives).toEqual([]); // the pool runs it
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([BACK]);
    expect((await w.row())?.photos).toBe("attached");
  });

  test("signed out, or someone else's row, is refused before anything runs", async () => {
    const w = await world({ photos: "failed" });
    await expect(w.t.action(api.intakePhotos.retryIntakePhotos, { matchId: w.matchId })).rejects.toThrow();
    await expect(
      w.t.withIdentity({ subject: "user_someoneElse" }).action(api.intakePhotos.retryIntakePhotos, { matchId: w.matchId }),
    ).rejects.toThrow();
    expect(derives).toEqual([]);
    expect((await w.row())?.photos).toBe("failed");
  });

  test("a row that isn't failed is refused", async () => {
    const w = await world({ photos: "pending" });
    await expect(w.me.action(api.intakePhotos.retryIntakePhotos, { matchId: w.matchId })).rejects.toThrow();
    expect(derives).toEqual([]);
  });
});

describe("reattachIntakeRunPhotos", () => {
  test("a run saved before the fix gets its photos and reports what happened", async () => {
    const w = await world();
    const runId = (await w.row())!.runId;
    expect((await w.row())?.photos).toBeUndefined();
    const report = await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId });
    expect(report).toEqual({ matches: 1, attached: 1, failed: 0, skipped: 0, continued: false });
    expect((await w.row())?.photos).toBe("attached");
    expect(await w.photos()).toHaveLength(2);
  });

  test("gone scans count as failed", async () => {
    const w = await world();
    const runId = (await w.row())!.runId;
    onDerive = gone;
    expect(await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId })).toEqual({
      matches: 1,
      attached: 0,
      failed: 1,
      skipped: 0,
      continued: false,
    });
  });

  test("unarmed, it refuses before reading anything", async () => {
    const w = await world();
    const runId = (await w.row())!.runId;
    vi.stubEnv(REATTACH_ENV_FLAG, "");
    await expect(w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId })).rejects.toThrow();
    expect(derives).toEqual([]);
    expect((await w.row())?.photos).toBeUndefined();
  });

  test("the wrong phrase is refused by the validator", async () => {
    const w = await world();
    const runId = (await w.row())!.runId;
    await expect(
      w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { confirm: "yes", runId } as never),
    ).rejects.toThrow();
    expect(derives).toEqual([]);
  });

  test("a row already attached is skipped, its removed photos staying removed", async () => {
    const w = await world();
    await w.attach();
    await w.me.mutation(api.copyPhotos.remove, { copyId: w.copyId, side: "front" });
    derives = [];
    const runId = (await w.row())!.runId;
    expect(await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId })).toEqual({
      matches: 0,
      attached: 0,
      failed: 0,
      skipped: 1,
      continued: false,
    });
    expect(derives).toEqual([]);
  });

  test("a stack is skipped: one scan must not stand for every copy on the line", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.patch(w.copyId, { quantity: 3 }));
    const runId = (await w.row())!.runId;
    expect(await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId })).toEqual({
      matches: 0,
      attached: 0,
      failed: 0,
      skipped: 1,
      continued: false,
    });
    expect(derives).toEqual([]);
    expect(await w.photos()).toEqual([]);
    expect((await w.row())?.photos).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Adversarial pass (NEO-427): overlapping runs, a copy that moves or goes
// mid-attach, an expiry racing the attach, and the reattach continuation.
// ---------------------------------------------------------------------------

type World = Awaited<ReturnType<typeof world>>;

/** Another saved pair on the world's run, with a copy of its own. */
async function extraSavedPair(w: World, cardId: Id<"cardChecklist">, frontIndex: number, backIndex: number) {
  const { copyId } = await w.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1 } });
  const matchId = await w.t.run(async (ctx) => {
    const base = (await ctx.db.get(w.matchId))!;
    const pairId = await ctx.db.insert("placeholderPairs", {
      jobId: JOB,
      userId: OWNER,
      frontIndex,
      backIndex,
      confidence: "exact",
      mechanism: "adjacency",
      score: 1,
    });
    return await ctx.db.insert("intakeMatches", {
      runId: base.runId,
      userId: OWNER,
      pairId,
      frontIndex,
      backIndex,
      readKey: "",
      confidence: 1,
      band: "matched",
      reason: "numberAndPlayer",
      candidates: [],
      variations: [],
      savedCopyId: copyId,
      savedQuantity: 1,
      savedAt: Date.now(),
    });
  });
  return { copyId, matchId };
}

describe("overlapping and interrupted attaches", () => {
  test("two attaches at once leave one live photo a side and a row that says attached", async () => {
    const w = await world({ photos: "pending" });
    await Promise.all([w.attach(), w.attach()]);
    // Both really ran the whole way (else this proves nothing about the commit guard).
    expect(derives.length).toBeGreaterThan(2);
    const rows = await w.photos();
    const live = rows.filter((r) => r.status === "live");
    expect(live.map((r) => r.side).sort()).toEqual(["back", "front"]);
    expect(rows.every((r) => r.status === "live" || r.status === "pending")).toBe(true);
    expect((await w.copy())?.hasPhotos).toBe(true);
    expect((await w.row())?.photos).toBe("attached");
  });

  test("a retry racing the original attach cannot leave two live photos on a side", async () => {
    const w = await world();
    await Promise.all([w.attach(), w.attach(), w.attach()]);
    const live = (await w.photos()).filter((r) => r.status === "live");
    expect(live).toHaveLength(2);
  });

  test("the copy removed before the attach runs ends failed, with no live photo anywhere", async () => {
    const w = await world({ photos: "pending" });
    await w.me.mutation(api.collection.removeCopy, { copyId: w.copyId });
    await w.attach();
    expect((await w.photos()).filter((r) => r.status === "live")).toEqual([]);
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "error" });
  });

  test("the copy removed mid-attach ends failed and leaves no live photo", async () => {
    const w = await world({ photos: "pending" });
    onPut = async () => {
      if (puts.length === 1) await w.me.mutation(api.collection.removeCopy, { copyId: w.copyId });
      return new Response(null, { status: 200 });
    };
    await w.attach();
    expect((await w.photos()).filter((r) => r.status === "live")).toEqual([]);
    expect((await w.row())?.photos).toBe("failed");
  });

  test("the copy moved to another box mid-attach still gets its photos", async () => {
    const w = await world({ photos: "pending" });
    const otherBox = await w.t.run((ctx) =>
      ctx.db.insert("collectionContainers", { ownerId: OWNER, kind: "box", name: "Elsewhere", lastUpdated: 0 }),
    );
    onPut = async () => {
      if (puts.length === 1) await w.me.mutation(api.collection.moveCopy, { copyId: w.copyId, toHomeId: otherBox });
      return new Response(null, { status: 200 });
    };
    await w.attach();
    expect((await w.photos()).filter((r) => r.status === "live").map((r) => r.copyId)).toEqual([w.copyId, w.copyId]);
    expect((await w.copy())?.homeId).toBe(otherBox);
    expect((await w.row())?.photos).toBe("attached");
  });

  test("the timeout firing mid-attach does not stop a success from landing", async () => {
    const w = await world({ photos: "pending" });
    onPut = async () => {
      if (puts.length === 1) await w.t.mutation(internal.intakeRuns.expireIntakePhotoAttach, { matchId: w.matchId });
      return new Response(null, { status: 200 });
    };
    await w.attach();
    expect(await w.row()).toMatchObject({ photos: "attached" });
    expect((await w.row())?.photoFailure).toBeUndefined();
  });

  test("a success after a timeout put the row at failed clears the failure reason", async () => {
    const w = await world({ photos: "pending" });
    await w.t.mutation(internal.intakeRuns.expireIntakePhotoAttach, { matchId: w.matchId });
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "error" });
    await w.attach();
    const row = await w.row();
    expect(row?.photos).toBe("attached");
    expect(row?.photoFailure).toBeUndefined();
  });

  test("Try again on a gone scan is refused; another pass with one side in asks only for the missing side, and stays gone", async () => {
    const w = await world();
    onDerive = (entryIndex) => (entryIndex === BACK ? gone() : derived(entryIndex));
    await w.attach();
    derives = [];
    await expect(w.me.action(api.intakePhotos.retryIntakePhotos, { matchId: w.matchId })).rejects.toThrow("aged out");
    expect(derives).toEqual([]);
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([BACK]);
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "scanGone" });
    expect((await w.photos()).filter((r) => r.status === "live")).toHaveLength(1);
  });

  test("Try again on a match that no longer exists is refused", async () => {
    const w = await world({ photos: "failed" });
    await w.t.run((ctx) => ctx.db.delete(w.matchId));
    await expect(w.me.action(api.intakePhotos.retryIntakePhotos, { matchId: w.matchId })).rejects.toThrow();
    expect(derives).toEqual([]);
  });

  test("Try again on a row whose copy is gone is refused before the service is asked", async () => {
    const w = await world({ photos: "failed" });
    await w.me.mutation(api.collection.removeCopy, { copyId: w.copyId });
    await expect(w.me.action(api.intakePhotos.retryIntakePhotos, { matchId: w.matchId })).rejects.toThrow(
      /left your collection/,
    );
    expect(derives).toEqual([]);
    expect((await w.row())?.photos).toBe("failed");
  });
});

describe("reattachIntakeRunPhotos on rows with hand photos, and its continuation", () => {
  test("both sides made up by hand: attached with no call to the service", async () => {
    const w = await world();
    await w.handPhoto("front");
    await w.handPhoto("back");
    const runId = (await w.row())!.runId;
    const report = await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId });
    expect(report).toEqual({ matches: 1, attached: 1, failed: 0, skipped: 0, continued: false });
    expect(derives).toEqual([]);
    expect((await w.photos()).map((r) => r.source)).toEqual([undefined, undefined]);
    expect((await w.row())?.photos).toBe("attached");
  });

  test("a hand front keeps standing and only the back is asked for", async () => {
    const w = await world();
    const hand = await w.handPhoto("front");
    const runId = (await w.row())!.runId;
    await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId });
    expect(derives.map((d) => d.entry_index)).toEqual([BACK]);
    const front = (await w.photos()).filter((r) => r.side === "front");
    expect(front).toHaveLength(1);
    expect(front[0]).toMatchObject({ _id: hand, status: "live" });
  });

  test("a row already failed that the run reattaches successfully ends attached", async () => {
    const w = await world({ photos: "failed" });
    const runId = (await w.row())!.runId;
    await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId });
    expect((await w.row())?.photos).toBe("attached");
  });

  /** Time moves past the budget once the first derive has been answered. */
  function budgetBlowsAfterFirstDerive() {
    let skew = 0;
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + skew);
    onDerive = (entryIndex) => {
      skew = 3 * 60 * 1000;
      return derived(entryIndex);
    };
  }
  const queuedReattaches = (w: World) =>
    w.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((f) =>
        f.name.includes("reattachIntakeRunPhotos"),
      ),
    );

  test("a run that outlasts its budget queues itself at the row it stopped on", async () => {
    const w = await world();
    const cards = await w.t.run(async (ctx) => (await ctx.db.query("cardChecklist").collect()).map((c) => c._id));
    const second = await extraSavedPair(w, cards[1], 8, 9);
    budgetBlowsAfterFirstDerive();
    const runId = (await w.row())!.runId;
    const report = await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId });
    expect(report).toEqual({ matches: 1, attached: 1, failed: 0, skipped: 0, continued: true });
    const queued = await queuedReattaches(w);
    expect(queued).toHaveLength(1);
    expect(queued[0].args[0]).toEqual({ ...reattach, runId, cursor: second.matchId });
  });

  test("a processed row removed between batches does not make the continuation skip the next one", async () => {
    const w = await world();
    const cards = await w.t.run(async (ctx) => (await ctx.db.query("cardChecklist").collect()).map((c) => c._id));
    const second = await extraSavedPair(w, cards[1], 8, 9);
    const runId = (await w.row())!.runId;
    budgetBlowsAfterFirstDerive();
    const first = await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId });
    expect(first.continued).toBe(true);
    const cursor = (await queuedReattaches(w))[0].args[0].cursor as Id<"intakeMatches">;
    // The sync drops the first row (its pair left the job) before the continuation runs.
    await w.t.run((ctx) => ctx.db.delete(w.matchId));
    derives = [];
    onDerive = derived;
    await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId, cursor });
    expect(derives.map((d) => d.entry_index).sort()).toEqual([8, 9]);
    expect((await w.t.run((ctx) => ctx.db.get(second.matchId)))?.photos).toBe("attached");
  });

  test("the cursor's own row removed starts the walk over: nothing is skipped, nothing attached is redone", async () => {
    const w = await world();
    const cards = await w.t.run(async (ctx) => (await ctx.db.query("cardChecklist").collect()).map((c) => c._id));
    const second = await extraSavedPair(w, cards[1], 8, 9);
    const third = await extraSavedPair(w, cards[2], 10, 11);
    const runId = (await w.row())!.runId;
    budgetBlowsAfterFirstDerive();
    await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId });
    const cursor = (await queuedReattaches(w))[0].args[0].cursor as Id<"intakeMatches">;
    expect(cursor).toBe(second.matchId);
    await w.t.run((ctx) => ctx.db.delete(second.matchId));
    derives = [];
    onDerive = derived;
    const report = await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId, cursor });
    expect(derives.map((d) => d.entry_index).sort((a, b) => a - b)).toEqual([10, 11]);
    expect(report).toMatchObject({ matches: 1, attached: 1, skipped: 1, continued: false });
    expect((await w.t.run((ctx) => ctx.db.get(third.matchId)))?.photos).toBe("attached");
  });

  test("each run logs its outcome, the only place a continuation's shows", async () => {
    const w = await world();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const runId = (await w.row())!.runId;
    await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId });
    const lines = log.mock.calls.map(([line]) => String(line));
    expect(lines.some((line) => line.includes('"event":"reattachIntakeRunPhotos"') && line.includes('"attached":1'))).toBe(
      true,
    );
  });

  test("a row saved between batches is picked up by the continuation", async () => {
    const w = await world();
    const cards = await w.t.run(async (ctx) => (await ctx.db.query("cardChecklist").collect()).map((c) => c._id));
    const second = await extraSavedPair(w, cards[1], 8, 9);
    const runId = (await w.row())!.runId;
    budgetBlowsAfterFirstDerive();
    await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId });
    const late = await extraSavedPair(w, cards[2], 10, 11);
    derives = [];
    onDerive = derived;
    const cursor = (await queuedReattaches(w))[0].args[0].cursor as Id<"intakeMatches">;
    await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId, cursor });
    expect(derives.map((d) => d.entry_index).sort((a, b) => a - b)).toEqual([8, 9, 10, 11]);
    expect((await w.t.run((ctx) => ctx.db.get(second.matchId)))?.photos).toBe("attached");
    expect((await w.t.run((ctx) => ctx.db.get(late.matchId)))?.photos).toBe("attached");
  });
});
