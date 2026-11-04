/**
 * NEO-427 — a scanned pair's photos onto the saved copy (`convex/intakePhotos.ts`):
 * both sides go to R2 and live, a repeat fills only what is missing, a photo
 * the collector added stays, and every failure ends on the row, never on the
 * save.
 *
 * The preprocess service and R2 are a stubbed `fetch`, the placeholder bucket is a
 * fake Storage client, and the copy rows are real. By default the bucket holds each
 * side's output but no stored sizes, so an attach falls back to the service.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_COPY_PHOTO_BYTES, MAX_COPY_THUMB_BYTES } from "./copyPhotos";
import { intakePhotoPool } from "./intakePhotoPool";
import { REATTACH_CONFIRM_PHRASE, REATTACH_ENV_FLAG } from "./intakePhotos";
import { PLACEHOLDER_MAX_ENTRY_INDEX } from "./lib/placeholderObjects";
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

const OUTPUT_DIR = `placeholders/${OWNER}/${JOB}/output`;
const padded = (entryIndex: number) => String(entryIndex).padStart(4, "0");
const outputKey = (entryIndex: number, extension = "jpg") => `${OUTPUT_DIR}/images/${padded(entryIndex)}.${extension}`;
const sizeKey = (entryIndex: number, size: "image" | "thumb") =>
  `${OUTPUT_DIR}/copy-photos/${size}/${padded(entryIndex)}.jpg`;

/** The placeholder bucket's objects, and every ranged read of them. */
let scans: Map<string, Buffer>;
let scanReads: Array<{ bucket: string; name: string; start?: number; end?: number }>;
let scanFailure: Error | undefined;
let scansHang: boolean;

vi.mock("@google-cloud/storage", () => {
  class FakeFile {
    constructor(
      private bucketName: string,
      private name: string,
    ) {}
    async download(options: { start?: number; end?: number }) {
      if (scansHang) return await new Promise<never>(() => {});
      if (scanFailure) throw scanFailure;
      scanReads.push({ bucket: this.bucketName, name: this.name, start: options.start, end: options.end });
      const bytes = scans.get(this.name);
      if (!bytes) throw Object.assign(new Error("No such object"), { code: 404 });
      return [bytes.subarray(options.start, options.end === undefined ? undefined : options.end + 1)];
    }
    async exists() {
      if (scanFailure) throw scanFailure;
      return [scans.has(this.name)];
    }
  }
  class FakeStorage {
    bucket(name: string) {
      return { file: (fileName: string) => new FakeFile(name, fileName) };
    }
  }
  return { Storage: FakeStorage };
});

/** Bytes that start the way a JPEG does, as every stored size must. */
const storedBytes = (label: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(label)]);
/** The same bytes as the R2 stub reads a PUT's body. */
const putBody = (label: string) => new TextDecoder().decode(storedBytes(label));

/** Both sizes of an entry, stored as `/process-entry` stores them. */
function storeSizes(entryIndex: number) {
  scans.set(sizeKey(entryIndex, "image"), storedBytes(`stored-image-${entryIndex}`));
  scans.set(sizeKey(entryIndex, "thumb"), storedBytes(`stored-thumb-${entryIndex}`));
}

type Derive = (entryIndex: number) => Response | Promise<Response>;

/** A promise the test answers when it chooses. */
function deferred() {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

/** Lets the attach run until `check` holds. It may never: the caller asserts after. */
async function until(check: () => boolean | Promise<boolean>) {
  for (let turn = 0; turn < 500 && !(await check()); turn++) await new Promise((resolve) => setImmediate(resolve));
}

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
  // Every entry a test here uses has been processed, unless the test says not.
  scans = new Map(Array.from({ length: 16 }, (_, index) => [outputKey(index), Buffer.from("output")]));
  scanReads = [];
  scanFailure = undefined;
  scansHang = false;
  vi.stubEnv("GCS_PLACEHOLDER_BUCKET", "scans");
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS_B64", Buffer.from("{}").toString("base64"));
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
    if (ms === 2_000 || ms === 8_000 || (ms === 5_000 && scansHang)) {
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
    let adding: Promise<Id<"collectionCopyPhotos">> | undefined;
    onPut = async (key) => {
      // Every PUT waits on it, so it is in before either side reaches its check.
      adding ??= w.handPhoto("front");
      await adding;
      expect(key).toContain("copy-photos/");
      return new Response(null, { status: 200 });
    };
    await w.attach();
    const hand = await adding;
    const rows = await w.photos();
    const fronts = rows.filter((r) => r.side === "front");
    expect(hand).toBeDefined();
    expect(fronts.find((r) => r._id === hand)?.status).toBe("live");
    expect(fronts.find((r) => r._id !== hand)).toMatchObject({ status: "pending", source: "intake" });
    // The guard is per side: the other side's scan still goes live.
    expect(rows.find((r) => r.side === "back")).toMatchObject({ status: "live", source: "intake" });
    const row = await w.row();
    expect(row?.photos).toBe("attached");
    expect(row?.photoSidesAttached).toEqual(["back"]);
  });

  test("scans expiring between the look and the derive say so, and nothing is reserved", async () => {
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
    expect((await w.row())?.photoSidesAttached?.toSorted()).toEqual(["back", "front"]);
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

describe("attachIntakePhotos reading stored sizes", () => {
  test("both sizes stored: they go to R2 and the service is not called", async () => {
    const w = await world({ photos: "pending" });
    storeSizes(FRONT);
    storeSizes(BACK);
    await w.attach();

    expect(derives).toEqual([]);
    const rows = await w.photos();
    expect(rows.map((r) => [r.side, r.status, r.source])).toEqual([
      ["back", "live", "intake"],
      ["front", "live", "intake"],
    ]);
    const front = rows[1];
    expect(front.imageBytes).toBe(storedBytes(`stored-image-${FRONT}`).length);
    expect(front.thumbBytes).toBe(storedBytes(`stored-thumb-${FRONT}`).length);
    expect(puts).toContainEqual({
      key: `copy-photos/${front.token}/image.jpg`,
      body: putBody(`stored-image-${FRONT}`),
      contentType: "image/jpeg",
    });
    expect(puts).toContainEqual({
      key: `copy-photos/${front.token}/thumb.jpg`,
      body: putBody(`stored-thumb-${FRONT}`),
      contentType: "image/jpeg",
    });
    expect(puts).toHaveLength(4);
    expect(await w.row()).toMatchObject({ photos: "attached" });
  });

  test("the keys come from the job row, in the named bucket, and each read is bounded", async () => {
    const w = await world();
    storeSizes(FRONT);
    storeSizes(BACK);
    await w.attach();
    expect(scanReads).toContainEqual({
      bucket: "scans",
      name: `placeholders/${OWNER}/${JOB}/output/copy-photos/image/0006.jpg`,
      start: 0,
      end: MAX_COPY_PHOTO_BYTES,
    });
    expect(scanReads).toContainEqual({
      bucket: "scans",
      name: `placeholders/${OWNER}/${JOB}/output/copy-photos/thumb/0007.jpg`,
      start: 0,
      end: MAX_COPY_THUMB_BYTES,
    });
  });

  test("neither size stored but the output there: the service makes them", async () => {
    const w = await world();
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([FRONT, BACK]);
    expect((await w.photos()).map((r) => r.status)).toEqual(["live", "live"]);
    expect(await w.row()).toMatchObject({ photos: "attached" });
  });

  test("a missing thumb alone falls back, and the stored image is not used", async () => {
    const w = await world();
    storeSizes(FRONT);
    storeSizes(BACK);
    scans.delete(sizeKey(BACK, "thumb"));
    await w.attach();
    expect(derives).toEqual([{ job_id: JOB, user_id: OWNER, entry_index: BACK }]);
    expect(puts.map((p) => p.body).sort()).toEqual(
      [`image-${BACK}`, `thumb-${BACK}`, putBody(`stored-image-${FRONT}`), putBody(`stored-thumb-${FRONT}`)].sort(),
    );
    expect(await w.row()).toMatchObject({ photos: "attached" });
  });

  test("a missing image alone falls back", async () => {
    const w = await world();
    storeSizes(FRONT);
    storeSizes(BACK);
    scans.delete(sizeKey(FRONT, "image"));
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([FRONT]);
    expect(await w.row()).toMatchObject({ photos: "attached" });
  });

  test("sizes gone and the output gone: scanGone with no call to the service", async () => {
    const w = await world({ photos: "pending" });
    scans.clear();
    await w.attach();
    expect(derives).toEqual([]);
    expect(await w.photos()).toEqual([]);
    expect(puts).toEqual([]);
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "scanGone" });
  });

  test("one size left and the output gone is still a gone scan", async () => {
    const w = await world();
    scans.clear();
    scans.set(sizeKey(FRONT, "image"), storedBytes("stored-image"));
    await w.attach();
    expect(derives).toEqual([]);
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "scanGone" });
  });

  test("an output of any extension counts as there", async () => {
    const w = await world();
    scans.clear();
    scans.set(outputKey(FRONT, "png"), Buffer.from("output"));
    scans.set(outputKey(BACK, "webp"), Buffer.from("output"));
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([FRONT, BACK]);
    expect(await w.row()).toMatchObject({ photos: "attached" });
  });

  test("one side gone keeps the side with stored sizes", async () => {
    const w = await world();
    storeSizes(FRONT);
    scans.delete(outputKey(BACK));
    await w.attach();
    expect(derives).toEqual([]);
    expect((await w.photos()).map((r) => [r.side, r.status])).toEqual([["front", "live"]]);
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "scanGone" });
  });

  test("a stored size over its limit is treated as missing", async () => {
    const w = await world();
    storeSizes(FRONT);
    storeSizes(BACK);
    scans.set(sizeKey(FRONT, "thumb"), Buffer.concat([storedBytes(""), Buffer.alloc(MAX_COPY_THUMB_BYTES)]));
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([FRONT]);
    expect(await w.row()).toMatchObject({ photos: "attached" });
  });

  test.each(["image", "thumb"] as const)("a stored %s that doesn't start like a JPEG is treated as missing", async (size) => {
    const w = await world();
    storeSizes(FRONT);
    storeSizes(BACK);
    scans.set(sizeKey(BACK, size), Buffer.from("<html>not a photo</html>"));
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([BACK]);
    expect(puts.map((p) => p.body)).not.toContain("<html>not a photo</html>");
    expect(await w.row()).toMatchObject({ photos: "attached" });
  });

  test("a bucket that can't be read is not a gone scan: the service answers", async () => {
    const w = await world();
    scanFailure = Object.assign(new Error("forbidden"), { code: 403 });
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([FRONT, BACK]);
    expect(await w.row()).toMatchObject({ photos: "attached" });
  });

  test("a bucket that can't be read still takes the service's word that the scan is gone", async () => {
    const w = await world();
    scanFailure = Object.assign(new Error("forbidden"), { code: 403 });
    onDerive = gone;
    await w.attach();
    expect(derives).toHaveLength(2);
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "scanGone" });
  });

  test("a read that never answers gives way to the service", async () => {
    const w = await world();
    scansHang = true;
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([FRONT, BACK]);
    expect(await w.row()).toMatchObject({ photos: "attached" });
  });

  test("a failed read logs its code, never the message that names the object", async () => {
    const w = await world();
    const url = `https://storage.googleapis.com/download/storage/v1/b/scans/o/${encodeURIComponent(sizeKey(FRONT, "image"))}?alt=media`;
    scanFailure = Object.assign(new Error(`request to ${url} failed`), { code: "ECONNRESET" });
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    await w.attach();
    expect(derives).toHaveLength(2);
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).toContain("could not read stored sizes, asking the service (code ECONNRESET)");
    for (const secret of ["storage.googleapis.com", "scans/o", OWNER, JOB, encodeURIComponent(OWNER)]) {
      expect(logged).not.toContain(secret);
    }
  });

  test("a code that isn't a plain code is not logged either", async () => {
    const w = await world();
    scanFailure = Object.assign(new Error("failed"), { code: `https://storage.googleapis.com/${OWNER}` });
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    await w.attach();
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).toContain("(code none)");
    expect(logged).not.toContain(OWNER);
  });

  test("a credential that can't be parsed never reaches the log", async () => {
    const w = await world();
    // JSON.parse quotes the text in its message, whole when the text is this short.
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS_B64", Buffer.from('{"k":SECRETKEY}').toString("base64"));
    const warn = vi.mocked(console.warn);
    warn.mockClear();
    await w.attach();
    expect(derives).toHaveLength(2);
    const logged = warn.mock.calls.flat().join("\n");
    expect(logged).toContain("could not read stored sizes, asking the service (code none)");
    expect(logged).not.toContain("SECRETKEY");
  });

  describe("identifiers out of shape go to the service, with no read of the bucket", () => {
    const refused = () => json(400, { error_code: "INVALID_IDENTIFIER", detail: "refused" });

    test.each([
      ["a path in the owner id", "../../user_other"],
      ["an owner id of the wrong shape", "not_a_clerk_id"],
    ])("%s", async (_name, userId) => {
      const w = await world();
      await w.t.run(async (ctx) => await ctx.db.patch(w.matchId, { userId }));
      onDerive = refused;
      await w.attach();
      expect(scanReads).toEqual([]);
      expect(derives).toHaveLength(2);
      expect(derives[0].user_id).toBe(userId);
      expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "error" });
    });

    test.each([
      ["a path in the job id", "../other-job"],
      ["a job id that isn't a UUID", "job-1"],
      ["a UUID with a trailing newline", `${JOB}\n`],
    ])("%s", async (_name, jobId) => {
      const w = await world();
      const runId = (await w.row())!.runId;
      await w.t.run(async (ctx) => await ctx.db.patch(runId, { jobId }));
      onDerive = refused;
      await w.attach();
      expect(scanReads).toEqual([]);
      expect(derives).toHaveLength(2);
      expect(derives[0].job_id).toBe(jobId);
      expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "error" });
    });

    test.each([
      ["negative", -1],
      ["fractional", 1.5],
      ["past the cap", PLACEHOLDER_MAX_ENTRY_INDEX + 1],
    ])("an entry index that is %s", async (_name, frontIndex) => {
      const w = await world();
      storeSizes(BACK);
      await w.t.run(async (ctx) => await ctx.db.patch(w.matchId, { frontIndex }));
      onDerive = refused;
      await w.attach();
      expect(scanReads.every((read) => read.name.includes(padded(BACK)))).toBe(true);
      expect(derives.map((d) => d.entry_index)).toEqual([frontIndex]);
      expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "error" });
    });

    test("the highest entry index is still read from the bucket", async () => {
      const w = await world();
      storeSizes(PLACEHOLDER_MAX_ENTRY_INDEX);
      storeSizes(BACK);
      await w.t.run(
        async (ctx) => await ctx.db.patch(w.matchId, { frontIndex: PLACEHOLDER_MAX_ENTRY_INDEX }),
      );
      await w.attach();
      expect(derives).toEqual([]);
      expect(await w.row()).toMatchObject({ photos: "attached" });
    });
  });

  test("no bucket configured falls back to the service", async () => {
    const w = await world();
    vi.stubEnv("GCS_PLACEHOLDER_BUCKET", "");
    await w.attach();
    expect(derives.map((d) => d.entry_index)).toEqual([FRONT, BACK]);
    expect(scanReads).toEqual([]);
    expect(await w.row()).toMatchObject({ photos: "attached" });
  });

  test("a run saved before sizes were stored reattaches through the fallback; one with sizes makes no call", async () => {
    const before = await world();
    const runId = (await before.row())!.runId;
    expect(await before.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId })).toMatchObject({
      attached: 1,
      failed: 0,
    });
    expect(derives.map((d) => d.entry_index)).toEqual([FRONT, BACK]);

    derives = [];
    storeSizes(FRONT);
    storeSizes(BACK);
    const after = await world();
    const afterRunId = (await after.row())!.runId;
    expect(await after.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId: afterRunId })).toMatchObject({
      attached: 1,
      failed: 0,
    });
    expect(derives).toEqual([]);
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
    scans.clear();
    expect(await w.t.action(internal.intakePhotos.reattachIntakeRunPhotos, { ...reattach, runId })).toEqual({
      matches: 1,
      attached: 0,
      failed: 1,
      skipped: 0,
      continued: false,
    });
    expect(derives).toEqual([]);
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

describe("attachIntakePhotos runs its sides together", () => {
  /** The side a PUT's key belongs to, by its row's token. */
  const sideOf = async (w: Awaited<ReturnType<typeof world>>, key: string) =>
    (await w.photos()).find((r) => key.includes(r.token))?.side;

  test("all four PUTs are in flight at once, and each side's bytes land on that side", async () => {
    storeSizes(FRONT);
    storeSizes(BACK);
    const w = await world({ photos: "pending" });
    const gate = deferred();
    onPut = async () => {
      await gate.held;
      return new Response(null, { status: 200 });
    };
    const attaching = w.attach();
    await until(() => puts.length === 4);
    // No PUT has been answered, so a loop over the sides would have stopped at the front's.
    expect(puts).toHaveLength(4);
    gate.release();
    await attaching;

    const rows = await w.photos();
    expect(rows.map((r) => [r.side, r.status])).toEqual([
      ["back", "live"],
      ["front", "live"],
    ]);
    for (const row of rows) {
      const entry = row.side === "front" ? FRONT : BACK;
      expect(puts).toContainEqual({
        key: `copy-photos/${row.token}/image.jpg`,
        body: putBody(`stored-image-${entry}`),
        contentType: "image/jpeg",
      });
      expect(puts).toContainEqual({
        key: `copy-photos/${row.token}/thumb.jpg`,
        body: putBody(`stored-thumb-${entry}`),
        contentType: "image/jpeg",
      });
    }
    expect((await w.row())?.photoSidesAttached?.toSorted()).toEqual(["back", "front"]);
  });

  test("the back landing first still leaves the front as the front", async () => {
    // The front has to ask the service, so the back reserves and commits ahead of it.
    storeSizes(BACK);
    const w = await world({ photos: "pending" });
    const frontHeld = deferred();
    onDerive = async (entryIndex) => {
      await frontHeld.held;
      return derived(entryIndex);
    };
    const attaching = w.attach();
    await until(async () => (await w.photos()).some((r) => r.side === "back" && r.status === "live"));
    expect((await w.photos()).map((r) => [r.side, r.status])).toEqual([["back", "live"]]);
    frontHeld.release();
    await attaching;

    const rows = await w.photos();
    const [front, back] = [rows.find((r) => r.side === "front")!, rows.find((r) => r.side === "back")!];
    // The back's row is the older one, and nothing reads that as its place.
    expect(back._creationTime).toBeLessThan(front._creationTime);
    const [urls] = await w.me.query(api.copyPhotos.photosOf, { copyIds: [w.copyId] });
    expect(urls.front?.imageUrl).toContain(front.token);
    expect(urls.back?.imageUrl).toContain(back.token);
    const listing = await w.t.query(internal.listingDrain.copyPhotosForListing, { ownerId: OWNER, copyIds: [w.copyId] });
    expect(listing.find((p) => p.side === "front")?.key).toContain(front.token);
    expect(listing.find((p) => p.side === "back")?.key).toContain(back.token);
    expect((await w.row())?.photos).toBe("attached");
  });

  test("both sides landing together queue the card's listing once, on one outbox row", async () => {
    storeSizes(FRONT);
    storeSizes(BACK);
    const w = await world({ photos: "pending" });
    await w.t.run((ctx) =>
      ctx.db.insert("marketplaceListingStates", { ownerId: OWNER, platform: "bsc", listingStartedAt: 1, lastUpdated: 0 }),
    );
    await w.attach();
    const outbox = await w.t.run((ctx) => ctx.db.query("listingOutbox").collect());
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ ownerId: OWNER, platform: "bsc", cardId: (await w.copy())?.cardId, seq: 2 });
  });

  test.each(["front", "back"] as const)("the %s's PUT failing still attaches the other side", async (failing) => {
    storeSizes(FRONT);
    storeSizes(BACK);
    const w = await world({ photos: "pending" });
    onPut = async (key) =>
      (await sideOf(w, key)) === failing ? new Response("denied", { status: 403 }) : new Response(null, { status: 200 });
    await w.attach();
    const landed = failing === "front" ? "back" : "front";
    const rows = await w.photos();
    expect(rows.find((r) => r.side === landed)?.status).toBe("live");
    expect(rows.find((r) => r.side === failing)?.status).toBe("pending");
    expect((await w.copy())?.hasPhotos).toBe(true);
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "error", photoSidesAttached: [landed] });
  });

  test("one size's PUT failing commits nothing for that side, and the attach waits for the other size", async () => {
    storeSizes(FRONT);
    storeSizes(BACK);
    const w = await world({ photos: "pending" });
    const thumbHeld = deferred();
    onPut = async (key) => {
      if ((await sideOf(w, key)) !== "front") return new Response(null, { status: 200 });
      if (key.includes("/image.")) return new Response("denied", { status: 403 });
      await thumbHeld.held;
      return new Response(null, { status: 200 });
    };
    let finished = false;
    const attaching = w.attach().then(() => {
      finished = true;
    });
    await until(() => finished);
    expect(finished).toBe(false);
    thumbHeld.release();
    await attaching;
    expect((await w.photos()).find((r) => r.side === "front")?.status).toBe("pending");
    expect((await w.row())?.photoFailure).toBe("error");
  });

  test.each([
    ["error", "scanGone", "error"],
    ["scanGone", "error", "error"],
    ["unusable", "scanGone", "unusable"],
    ["scanGone", "unusable", "unusable"],
    ["error", "unusable", "error"],
    ["unusable", "error", "error"],
  ] as const)("front %s and back %s report %s", async (front, back, reported) => {
    const answers = {
      error: () => json(503, {}),
      scanGone: gone,
      unusable: () => json(422, { error_code: "OUTPUT_UNDECODABLE" }),
    };
    const w = await world({ photos: "pending" });
    onDerive = (entryIndex) => answers[entryIndex === FRONT ? front : back]();
    await w.attach();
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: reported });
  });

  test("two sides falling back ask the service one at a time", async () => {
    const w = await world({ photos: "pending" });
    const frontHeld = deferred();
    onDerive = async (entryIndex) => {
      if (entryIndex === FRONT) await frontHeld.held;
      return derived(entryIndex);
    };
    const attaching = w.attach();
    await until(() => derives.length === 2);
    expect(derives.map((d) => d.entry_index)).toEqual([FRONT]);
    frontHeld.release();
    await attaching;
    expect(derives.map((d) => d.entry_index)).toEqual([FRONT, BACK]);
    expect((await w.row())?.photos).toBe("attached");
  });

  test("a side's derive failing doesn't stop the other side's from being asked", async () => {
    const w = await world({ photos: "pending" });
    onDerive = (entryIndex) => (entryIndex === FRONT ? gone() : derived(entryIndex));
    await w.attach();
    expect((await w.photos()).map((r) => [r.side, r.status])).toEqual([["back", "live"]]);
    expect(await w.row()).toMatchObject({ photos: "failed", photoFailure: "scanGone" });
  });

  test("a side with stored sizes doesn't wait on the other side's derive", async () => {
    storeSizes(BACK);
    const w = await world({ photos: "pending" });
    const frontHeld = deferred();
    onDerive = async (entryIndex) => {
      await frontHeld.held;
      return derived(entryIndex);
    };
    const attaching = w.attach();
    await until(() => puts.length === 2);
    expect(puts).toHaveLength(2);
    expect(derives.map((d) => d.entry_index)).toEqual([FRONT]);
    frontHeld.release();
    await attaching;
    expect((await w.row())?.photos).toBe("attached");
  });

  test("the copy removed while both sides are mid-PUT ends failed, with no side counted as landed", async () => {
    storeSizes(FRONT);
    storeSizes(BACK);
    const w = await world({ photos: "pending" });
    const gate = deferred();
    onPut = async () => {
      await gate.held;
      return new Response(null, { status: 200 });
    };
    const attaching = w.attach();
    await until(() => puts.length === 4);
    expect(puts).toHaveLength(4);
    await w.me.mutation(api.collection.removeCopy, { copyId: w.copyId });
    gate.release();
    await attaching;
    expect(await w.photos()).toEqual([]);
    const row = await w.row();
    expect(row).toMatchObject({ photos: "failed", photoFailure: "error" });
    expect(row?.photoSidesAttached).toBeUndefined();
  });
});

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
