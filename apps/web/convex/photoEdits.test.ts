/**
 * NEO-481 — hand photo edits (turn + crop), end to end through the actions:
 * which source a photo opens on, the reserve's guards and caps, the version
 * race, the asynchronous render and its commit (re-read by the first-read
 * rule, a failed photo rescued), an original that ages out mid-save writing
 * nothing, and a saved copy's edit replacing its live photo (and its Undo).
 *
 * The preprocess service and R2 are a stubbed `fetch`; the placeholder bucket
 * is a fake Storage client; every row is real.
 */

import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { PLACEHOLDER_MAX_IMAGE_EDITS, MAX_COPY_PHOTO_EDITS_PER_HOUR } from "./lib/photoEdit";
import { PHOTO_EDIT_COPY } from "./photoEditRows";
import schema from "./schema";
import { drainScheduled } from "../lib/testing/drain-scheduled";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const OWNER = "user_editOwner01";
const OTHER = "user_editOther02";
const JOB = "3f2504e0-4f89-11d3-9a0c-0305e82c3302";
const FRONT = 4;
const BACK = 5;

const padded = (i: number) => String(i).padStart(4, "0");
const PREFIX = `placeholders/${OWNER}/${JOB}`;
const extractedKey = (i: number, ext = "jpg") => `${PREFIX}/extracted/${padded(i)}.${ext}`;
const editKey = (i: number, version: number) => `${PREFIX}/output/edits/${padded(i)}/${version}.jpg`;
const editSizeKey = (i: number, version: number, size: "image" | "thumb") =>
  `${PREFIX}/output/edits/${padded(i)}/${version}/${size}.jpg`;

const jpeg = (label: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(label)]);

/** The placeholder bucket. */
let bucket: Map<string, Buffer>;

vi.mock("@google-cloud/storage", () => {
  class FakeFile {
    constructor(private name: string) {}
    async download(options: { start?: number; end?: number }) {
      const bytes = bucket.get(this.name);
      if (!bytes) throw Object.assign(new Error("No such object"), { code: 404 });
      return [bytes.subarray(options.start, options.end === undefined ? undefined : options.end + 1)];
    }
    async exists() {
      return [bucket.has(this.name)];
    }
    async getSignedUrl() {
      return [`https://storage.example/${this.name}`];
    }
  }
  class FakeStorage {
    bucket() {
      return { file: (name: string) => new FakeFile(name) };
    }
  }
  return { Storage: FakeStorage };
});

type ScanRender = {
  job_id: string;
  user_id: string;
  entry_index: number;
  version: number;
  classify: boolean;
  edit: { turns: number; crop: null | Record<string, number> };
};

let scanRenders: ScanRender[];
let bytesRenders: Array<{ edit: unknown; imageBytes: number }>;
let puts: Array<{ key: string; body: string }>;
let r2Gets: string[];
let onScanRender: (body: ScanRender) => Response;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The service's scan form: writes the render and its sizes, answers with the re-read. */
function renderOk(read: Record<string, unknown> = {}) {
  return (body: ScanRender) => {
    bucket.set(editKey(body.entry_index, body.version), jpeg("full"));
    bucket.set(editSizeKey(body.entry_index, body.version, "image"), jpeg(`image-v${body.version}`));
    bucket.set(editSizeKey(body.entry_index, body.version, "thumb"), jpeg(`thumb-v${body.version}`));
    const photo = (width: number) => ({ width, height: width, size_bytes: 10, data_b64: null });
    return json(200, {
      content_type: "image/jpeg",
      version: body.version,
      crop: photo(1000),
      image: photo(1600),
      thumb: photo(360),
      ...(body.classify ? { classified: true, ...read } : { classified: false, players: [] }),
    });
  };
}

beforeEach(() => {
  bucket = new Map([
    [extractedKey(FRONT), jpeg("original-front")],
    [extractedKey(BACK, "png"), Buffer.from("original-back")],
  ]);
  scanRenders = [];
  bytesRenders = [];
  puts = [];
  r2Gets = [];
  onScanRender = renderOk({
    players: ["Dwight Gooden"],
    team: "Mets",
    card_number: "7",
    side: "back",
    text_count: 3,
    dhash: "0123456789abcdef",
    orient_confidence: 0.9,
  });
  vi.stubEnv("GCS_PLACEHOLDER_BUCKET", "scans");
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS_B64", Buffer.from("{}").toString("base64"));
  vi.stubEnv("NEONBINDER_PREPROCESS_URL", "http://localhost:8081");
  vi.stubEnv("NEONBINDER_PREPROCESS_FAST_URL", "");
  vi.stubEnv("R2_ENDPOINT", "https://acct.r2.example");
  vi.stubEnv("R2_BUCKET", "photos");
  vi.stubEnv("R2_ACCESS_KEY_ID", "AKIDEXAMPLE");
  vi.stubEnv("R2_SECRET_ACCESS_KEY", "secret");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/warmup") return json(200, { status: "warm" });
    if (url.pathname === "/render-edit") {
      if ((request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
        const form = await request.formData();
        const image = form.get("image") as Blob;
        bytesRenders.push({ edit: JSON.parse(String(form.get("edit"))), imageBytes: image.size });
        return json(200, {
          image: { width: 1600, height: 1200, size_bytes: 15, data_b64: jpeg("edited-image").toString("base64") },
          thumb: { width: 360, height: 270, size_bytes: 15, data_b64: jpeg("edited-thumb").toString("base64") },
          content_type: "image/jpeg",
        });
      }
      const body = (await request.json()) as ScanRender;
      scanRenders.push(body);
      return onScanRender(body);
    }
    if (url.host === "acct.r2.example") {
      const key = decodeURIComponent(url.pathname.replace(/^\/photos\//, ""));
      if (request.method === "PUT") {
        puts.push({ key, body: await request.text() });
        return new Response(null, { status: 200 });
      }
      r2Gets.push(key);
      const body = jpeg("stored-photo");
      return new Response(body, { status: 200, headers: { "content-length": String(body.byteLength) } });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  }) as unknown as typeof fetch);
});

let harnesses: Array<ReturnType<typeof convexTest>> = [];
afterEach(async () => {
  for (const t of harnesses) await drainScheduled(t);
  harnesses = [];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type ImageFields = Partial<Doc<"placeholderImages">>;
const DONE_FRONT: ImageFields = {
  status: "done",
  side: "front",
  players: ["Doc Gooden"],
  textCount: 5,
  rotationDegrees: 90,
  autoCrop: { cx: 500, cy: 700, w: 800, h: 1100, angle: 2, srcW: 1000, srcH: 1400 },
  settledAt: 1,
};
const DONE_BACK: ImageFields = { status: "done", side: "back", players: ["Doc Gooden"], textCount: 80, settledAt: 1 };

const EDIT = {
  turns: 1 as const,
  crop: { cx: 500, cy: 700, w: 600, h: 900, angle: -10, srcW: 1000, srcH: 1400 },
};

async function world(
  opts: {
    front?: ImageFields;
    job?: Partial<Doc<"placeholderJobs">>;
    match?: Partial<Doc<"intakeMatches">> | null;
  } = {},
) {
  const t = convexTest(schema, modules);
  harnesses.push(t);
  const fx = await seedCollectionCatalog(t);
  const front = { ...DONE_FRONT, ...opts.front };
  const ids = await t.run(async (ctx) => {
    await ctx.db.insert("placeholderJobs", {
      jobId: JOB,
      userId: OWNER,
      objectPath: `${PREFIX}/`,
      createdAt: 0,
      mode: "stream",
      status: "succeeded",
      totalImages: 2,
      processedImages: front.status === "failed" ? 1 : 2,
      failedImages: front.status === "failed" ? 1 : 0,
      ...opts.job,
    });
    const frontId = await ctx.db.insert("placeholderImages", {
      jobId: JOB,
      userId: OWNER,
      entryIndex: FRONT,
      originalName: "front.jpg",
      status: "done",
      ...front,
    });
    await ctx.db.insert("placeholderImages", {
      jobId: JOB,
      userId: OWNER,
      entryIndex: BACK,
      originalName: "back.png",
      status: "done",
      ...DONE_BACK,
    });
    const homeId = await ctx.db.insert("collectionContainers", {
      ownerId: OWNER,
      kind: "box",
      name: "For sale",
      lastUpdated: 0,
    });
    const runId = await ctx.db.insert("intakeRuns", {
      userId: OWNER,
      jobId: JOB,
      homeId,
      variantId: fx.baseId,
      createdAt: 0,
      lastActivityAt: 0,
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
    const matchId =
      opts.match === null
        ? null
        : await ctx.db.insert("intakeMatches", {
            runId,
            userId: OWNER,
            pairId,
            frontIndex: FRONT,
            backIndex: BACK,
            readKey: "x",
            confidence: 1,
            band: "matched",
            reason: "numberAndPlayer",
            candidates: [],
            variations: [],
            ...opts.match,
          });
    return { frontId, runId, pairId, matchId, homeId };
  });
  const me = t.withIdentity({ subject: OWNER });
  const image = () => t.run((ctx) => ctx.db.get(ids.frontId));
  const jobRow = () =>
    t.run((ctx) =>
      ctx.db
        .query("placeholderJobs")
        .withIndex("by_job", (q) => q.eq("jobId", JOB))
        .unique(),
    );
  return { t, fx, me, them: t.withIdentity({ subject: OTHER }), ...ids, image, jobRow };
}

const scanRef = { kind: "scan" as const, jobId: JOB, entryIndex: FRONT };

describe("photoEditSource: a scan", () => {
  test("a done scan whose original is there opens on the original, at today's output", async () => {
    const w = await world();
    const source = await w.me.action(api.photoEdits.photoEditSource, { ref: scanRef });
    expect(source.mode).toBe("original");
    expect(source.sourceUrl).toBe(`https://storage.example/${extractedKey(FRONT)}`);
    // rotationDegrees is counter-clockwise; 90 CCW opens as three clockwise quarter turns.
    expect(source.edit).toEqual({ turns: 3, crop: DONE_FRONT.autoCrop });
    expect(source.autoCrop).toEqual(DONE_FRONT.autoCrop);
    expect([source.srcW, source.srcH]).toEqual([1000, 1400]);
    expect(source.expectVersion).toBe(0);
    expect(source.editsLeft).toBe(PLACEHOLDER_MAX_IMAGE_EDITS);
  });

  test("view-only, with the reason, while still being read, once the original is gone, and once saved", async () => {
    const reading = await world({ front: { status: "processing" } });
    expect(await reading.me.action(api.photoEdits.photoEditSource, { ref: scanRef })).toMatchObject({
      mode: "viewOnly",
      reason: PHOTO_EDIT_COPY.stillReading,
    });

    const gone = await world();
    bucket.delete(extractedKey(FRONT));
    expect(await gone.me.action(api.photoEdits.photoEditSource, { ref: scanRef })).toMatchObject({
      mode: "viewOnly",
      reason: PHOTO_EDIT_COPY.scanGone,
    });

    const saved = await world({ match: { savedAt: 1 } });
    expect(await saved.me.action(api.photoEdits.photoEditSource, { ref: scanRef })).toMatchObject({
      mode: "viewOnly",
      reason: PHOTO_EDIT_COPY.savedPair,
    });
  });

  test("a scan with no auto crop opens at its own turn on the whole frame (crop by hand)", async () => {
    const w = await world({ front: { status: "failed", errorCode: "PROCESS_ENTRY_FAILED" } });
    await w.t.run((ctx) => ctx.db.patch(w.frontId, { autoCrop: undefined }));
    const source = await w.me.action(api.photoEdits.photoEditSource, { ref: scanRef });
    expect(source.mode).toBe("original");
    // rotationDegrees 90 (counter-clockwise) is three clockwise quarter turns, filled by the server.
    expect(source.edit).toEqual({ turns: 3, crop: null });
    expect(source.autoCrop).toBeUndefined();
    expect(source.srcW).toBeUndefined();
  });

  test("a scan with a hand edit opens on that edit, at its version", async () => {
    const w = await world();
    await w.t.run((ctx) => ctx.db.patch(w.frontId, { edit: { ...EDIT, version: 2, editedAt: 1 } }));
    const source = await w.me.action(api.photoEdits.photoEditSource, { ref: scanRef });
    expect(source.edit).toEqual(EDIT);
    expect(source.expectVersion).toBe(2);
  });

  test("a view-only answer still carries the opening edit", async () => {
    const saved = await world({ match: { savedAt: 1 } });
    expect(await saved.me.action(api.photoEdits.photoEditSource, { ref: scanRef })).toMatchObject({
      mode: "viewOnly",
      edit: { turns: 3, crop: DONE_FRONT.autoCrop },
    });

    const gone = await world({ front: { status: "failed", errorCode: "PROCESS_ENTRY_FAILED", rotationDegrees: 0 } });
    await gone.t.run((ctx) => ctx.db.patch(gone.frontId, { autoCrop: undefined }));
    bucket.delete(extractedKey(FRONT));
    expect(await gone.me.action(api.photoEdits.photoEditSource, { ref: scanRef })).toMatchObject({
      mode: "viewOnly",
      reason: PHOTO_EDIT_COPY.scanGone,
      edit: { turns: 0, crop: null },
    });
  });

  test("another collector's scan is not found, and its original is never looked at", async () => {
    const w = await world();
    await expect(w.them.action(api.photoEdits.photoEditSource, { ref: scanRef })).rejects.toThrow(/isn't in your batch/);
  });
});

describe("saveScanEdit: reserve, render, commit", () => {
  test("the save returns at once; the render re-reads and the commit writes the edit by the first-read rule", async () => {
    const w = await world();
    const { version } = await w.me.action(api.photoEdits.saveScanEdit, {
      jobId: JOB,
      entryIndex: FRONT,
      edit: EDIT,
      expectVersion: 0,
    });
    expect(version).toBe(1);
    await drainScheduled(w.t);

    expect(scanRenders).toEqual([
      {
        job_id: JOB,
        user_id: OWNER,
        entry_index: FRONT,
        version: 1,
        classify: true,
        edit: { turns: 1, crop: { cx: 500, cy: 700, w: 600, h: 900, angle: -10, src_w: 1000, src_h: 1400 } },
      },
    ]);
    const row = await w.image();
    expect(row?.edit).toMatchObject({ ...EDIT, version: 1 });
    expect(row?.pendingEdit).toBeUndefined();
    expect(row?.edits).toBe(1);
    // Identity is re-read...
    expect(row?.players).toEqual(["Dwight Gooden"]);
    expect(row?.team).toBe("Mets");
    expect(row?.cardNumber).toBe("7");
    // ...but a done photo's side and text count never move, and orientation is the edit's.
    expect(row?.side).toBe("front");
    expect(row?.textCount).toBe(5);
    expect(row?.rotationDegrees).toBe(90);
    // A field it never had is filled.
    expect(row?.dhash).toBe("0123456789abcdef");
  });

  test("the first save wins: a second save from the same opening is refused", async () => {
    const w = await world();
    await w.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 });
    await drainScheduled(w.t);
    await expect(
      w.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 }),
    ).rejects.toThrow(PHOTO_EDIT_COPY.changedElsewhere);
  });

  test("the per-scan cap counts reserves, and a crop past the frame is refused before anything", async () => {
    const w = await world({ front: { edits: PLACEHOLDER_MAX_IMAGE_EDITS } });
    await expect(
      w.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 }),
    ).rejects.toThrow(PHOTO_EDIT_COPY.tooManyEdits);
    const fresh = await world();
    await expect(
      fresh.me.action(api.photoEdits.saveScanEdit, {
        jobId: JOB,
        entryIndex: FRONT,
        edit: { turns: 0, crop: { ...EDIT.crop, cx: 950 } },
        expectVersion: 0,
      }),
    ).rejects.toThrow(/past the edge/);
    expect((await fresh.image())?.edits).toBeUndefined();
    expect(scanRenders).toEqual([]);
  });

  test("a pair picked by hand is rendered without the paid re-read; a saved pair is refused", async () => {
    const byUser = await world({ match: { byUser: true } });
    await byUser.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 });
    await drainScheduled(byUser.t);
    expect(scanRenders.map((r) => r.classify)).toEqual([false]);
    expect((await byUser.image())?.players).toEqual(["Doc Gooden"]);

    const saved = await world({ match: { savedAt: 1 } });
    await expect(
      saved.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 }),
    ).rejects.toThrow(PHOTO_EDIT_COPY.savedPair);
  });

  test("a re-read that failed (classified false) renders but writes no read field", async () => {
    const w = await world();
    const render = renderOk();
    onScanRender = (body) => {
      render(body);
      return json(200, {
        content_type: "image/jpeg",
        version: body.version,
        image: { width: 1600, height: 1600, size_bytes: 1, data_b64: null },
        thumb: { width: 360, height: 360, size_bytes: 1, data_b64: null },
        classified: false,
        players: [],
        player: null,
        team: null,
        card_number: null,
        side: null,
      });
    };
    await w.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 });
    await drainScheduled(w.t);
    const row = await w.image();
    expect(row?.edit?.version).toBe(1);
    expect(row?.players).toEqual(["Doc Gooden"]);
    expect(row?.side).toBe("front");
  });

  test("a version the service already rendered (409) is taken as done when its render is there", async () => {
    const w = await world();
    onScanRender = (body) => {
      renderOk()(body);
      return json(409, { error_code: "VERSION_EXISTS", detail: "this edit version is already rendered" });
    };
    await w.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 });
    await drainScheduled(w.t);
    const row = await w.image();
    expect(row?.edit?.version).toBe(1);
    expect(row?.pendingEdit).toBeUndefined();
    expect(row?.players).toEqual(["Doc Gooden"]);
    expect(scanRenders).toHaveLength(1);
  });

  test("an edit the service refuses (422) fails without a retry, in plain words", async () => {
    const w = await world();
    onScanRender = () => json(422, { error_code: "EDIT_OUT_OF_FRAME", detail: "crop reaches outside the source" });
    await w.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 });
    await drainScheduled(w.t);
    expect(scanRenders).toHaveLength(1);
    expect((await w.image())?.pendingEdit).toMatchObject({ status: "failed", error: PHOTO_EDIT_COPY.unusable });
  });

  test("an original that ages out mid-save writes nothing but the counter and the failure", async () => {
    const w = await world();
    onScanRender = () => json(404, { error_code: "ENTRY_NOT_FOUND", detail: "gone" });
    const before = await w.image();
    await w.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 });
    await drainScheduled(w.t);
    const after = await w.image();
    expect(after?.edit).toBeUndefined();
    expect(after?.edits).toBe(1);
    expect(after?.pendingEdit).toMatchObject({ status: "failed", error: PHOTO_EDIT_COPY.scanGone, version: 1 });
    for (const field of ["status", "players", "team", "cardNumber", "side", "settledAt"] as const) {
      expect(after?.[field]).toEqual(before?.[field]);
    }
    // The failure shows on the subscription the tiles read, and Dismiss clears it.
    const listed = await w.me.query(api.placeholderPipeline.listPlaceholderImages, { jobId: JOB });
    expect(listed.find((i) => i.entryIndex === FRONT)?.pendingEdit?.status).toBe("failed");
    await w.me.action(api.photoEdits.dismissPhotoEditFailure, { ref: scanRef });
    expect((await w.image())?.pendingEdit).toBeUndefined();
  });

  test("a failed photo is rescued by a hand crop: done, the first read, and the job's counters move", async () => {
    const w = await world({
      front: {
        status: "failed",
        errorCode: "PROCESS_ENTRY_FAILED",
        errorDetail: "no card found",
        side: undefined,
        players: undefined,
        textCount: undefined,
        autoCrop: undefined,
      },
    });
    const source = await w.me.action(api.photoEdits.photoEditSource, { ref: scanRef });
    expect(source.mode).toBe("original");
    expect(source.edit?.crop).toBeNull();
    await w.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 });
    await drainScheduled(w.t);
    const row = await w.image();
    expect(row?.status).toBe("done");
    expect(row?.errorCode).toBeUndefined();
    expect(row?.errorDetail).toBeUndefined();
    expect(row?.side).toBe("back");
    expect(row?.textCount).toBe(3);
    const job = await w.jobRow();
    expect([job?.processedImages, job?.failedImages]).toEqual([2, 0]);
  });

  test("a photo over the pixel ceiling opens view-only and cannot be saved", async () => {
    const w = await world({ front: { status: "failed", errorCode: "ENTRY_TOO_MANY_PIXELS" } });
    expect((await w.me.action(api.photoEdits.photoEditSource, { ref: scanRef })).mode).toBe("viewOnly");
    await expect(
      w.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 }),
    ).rejects.toThrow(PHOTO_EDIT_COPY.tooBig);
  });
});

describe("commitScanEdit: re-checks what the reserve saw", () => {
  async function pending(w: Awaited<ReturnType<typeof world>>) {
    await w.t.run((ctx) =>
      ctx.db.patch(w.frontId, {
        edits: 1,
        pendingEdit: { ...EDIT, version: 1, requestedAt: Date.now(), status: "rendering" },
      }),
    );
  }

  test("a Try again or restart in between (status or settledAt moved) refuses and writes the failure", async () => {
    const w = await world();
    await pending(w);
    const refused = await w.t.mutation(internal.photoEditRows.commitScanEdit, {
      imageId: w.frontId,
      version: 1,
      expectVersion: 0,
      imageStatus: "done",
      settledAt: 999,
    });
    expect(refused).toBe(PHOTO_EDIT_COPY.restarted);
    const row = await w.image();
    expect(row?.edit).toBeUndefined();
    expect(row?.pendingEdit?.status).toBe("failed");
  });

  test("a pair saved after the reserve refuses the commit", async () => {
    const w = await world();
    await pending(w);
    await w.t.run((ctx) => ctx.db.patch(w.matchId!, { savedAt: 2 }));
    const refused = await w.t.mutation(internal.photoEditRows.commitScanEdit, {
      imageId: w.frontId,
      version: 1,
      expectVersion: 0,
      imageStatus: "done",
      settledAt: 1,
    });
    expect(refused).toBe(PHOTO_EDIT_COPY.savedWhileCropping);
    expect((await w.image())?.edit).toBeUndefined();
  });

  test("the download mint serves the edit's render once it is current", async () => {
    const w = await world();
    await w.me.action(api.photoEdits.saveScanEdit, { jobId: JOB, entryIndex: FRONT, edit: EDIT, expectVersion: 0 });
    await drainScheduled(w.t);
    const minted = await w.me.action(api.adapters.placeholderUploads.createPlaceholderImageDownloadUrl, {
      jobId: JOB,
      entryIndex: FRONT,
    });
    expect(minted.url).toBe(`https://storage.example/${editKey(FRONT, 1)}`);
    const listed = await w.me.query(api.placeholderPipeline.listPlaceholderImages, { jobId: JOB });
    expect(listed.find((i) => i.entryIndex === FRONT)).toMatchObject({ editVersion: 1, edits: 1 });
  });
});

describe("saved copies", () => {
  async function copyWorld(opts: { scan?: boolean } = {}) {
    const w = await world({ match: null });
    const { copyId, photoId, token } = await w.t.run(async (ctx) => {
      const copyId = await ctx.db.insert("collectionCopies", {
        ownerId: OWNER,
        cardId: w.fx.gooden1,
        variantId: w.fx.baseId,
        setId: w.fx.setId,
        homeId: w.homeId,
        quantity: 1,
        hasPhotos: true,
        lastUpdated: 0,
      });
      const token = "b".repeat(32);
      const photoId = await ctx.db.insert("collectionCopyPhotos", {
        ownerId: OWNER,
        copyId,
        side: "front",
        token,
        contentType: "image/jpeg",
        imageBytes: 100,
        thumbBytes: 10,
        status: "live",
        since: 1,
        ...(opts.scan ? { source: "intake" as const, scan: { jobId: JOB, entryIndex: FRONT } } : {}),
      });
      return { copyId, photoId, token };
    });
    const rows = () => w.t.run((ctx) => ctx.db.query("collectionCopyPhotos").collect());
    return { ...w, copyId, photoId, token, rows };
  }
  const copyRef = (copyId: Id<"collectionCopies">) => ({ kind: "copy" as const, copyId, side: "front" as const });

  test("a hand photo opens on the stored image; its edit renders from the bytes and replaces the live photo", async () => {
    const w = await copyWorld();
    const source = await w.me.action(api.photoEdits.photoEditSource, { ref: copyRef(w.copyId) });
    expect(source).toMatchObject({ mode: "stored", expectToken: w.token, edit: { turns: 0, crop: null } });
    expect(source.sourceUrl).toMatch(new RegExp(`/copy-photo/${w.token}/image$`));

    const { photoId: editId } = await w.me.action(api.photoEdits.saveCopyPhotoEdit, {
      copyId: w.copyId,
      side: "front",
      edit: { turns: 1, crop: null },
      expectToken: w.token,
      mode: "stored",
    });
    // Until the render lands, the old photo is live and the reader says the edit is on its way.
    const during = await w.me.query(api.copyPhotos.photosOf, { copyIds: [w.copyId] });
    expect(during[0].front?.imageUrl).toMatch(w.token);
    await drainScheduled(w.t);

    expect(r2Gets).toEqual([`copy-photos/${w.token}/image.jpg`]);
    expect(bytesRenders).toEqual([{ edit: { turns: 1, crop: null }, imageBytes: jpeg("stored-photo").byteLength }]);
    const rows = await w.rows();
    const edited = rows.find((r) => r._id === editId)!;
    expect(edited).toMatchObject({ status: "live", source: "edit", side: "front", contentType: "image/jpeg" });
    expect(edited.pendingEdit).toBeUndefined();
    expect(rows.find((r) => r._id === w.photoId)?.status).toBe("replaced");
    expect(puts.map((p) => p.key).sort()).toEqual([`copy-photos/${edited.token}/image.jpg`, `copy-photos/${edited.token}/thumb.jpg`]);

    // Undo inside the hour puts the photo before it back.
    await w.me.action(api.photoEdits.undoCopyPhotoEdit, { copyId: w.copyId, photoId: editId });
    const undone = await w.rows();
    expect(undone.find((r) => r._id === w.photoId)?.status).toBe("live");
    expect(undone.find((r) => r._id === editId)?.status).toBe("replaced");
    // ...once.
    await expect(w.me.action(api.photoEdits.undoCopyPhotoEdit, { copyId: w.copyId, photoId: editId })).rejects.toThrow(
      /can't be undone/,
    );
  });

  test("a photo made from a live scan edits from its original, and the commit writes the scan's edit too", async () => {
    const w = await copyWorld({ scan: true });
    const source = await w.me.action(api.photoEdits.photoEditSource, { ref: copyRef(w.copyId) });
    expect(source).toMatchObject({ mode: "original", expectToken: w.token });
    await w.me.action(api.photoEdits.saveCopyPhotoEdit, {
      copyId: w.copyId,
      side: "front",
      edit: EDIT,
      expectToken: w.token,
      mode: "original",
    });
    await drainScheduled(w.t);
    expect(scanRenders.map((r) => [r.version, r.classify])).toEqual([[1, false]]);
    const image = await w.image();
    expect(image?.edit?.version).toBe(1);
    // Render only: no re-read on a saved copy's edit.
    expect(image?.players).toEqual(["Doc Gooden"]);
    const live = (await w.rows()).find((r) => r.status === "live")!;
    expect(live).toMatchObject({ source: "edit", scan: { jobId: JOB, entryIndex: FRONT } });
    expect(puts.find((p) => p.key.endsWith("image.jpg"))?.body).toBe(new TextDecoder().decode(jpeg("image-v1")));
  });

  test("an edit of a photo replaced since it was opened is refused before any render", async () => {
    const w = await copyWorld();
    await expect(
      w.me.action(api.photoEdits.saveCopyPhotoEdit, {
        copyId: w.copyId,
        side: "front",
        edit: { turns: 2, crop: null },
        expectToken: "c".repeat(32),
        mode: "stored",
      }),
    ).rejects.toThrow(/changed since you opened it/);
    expect(bytesRenders).toEqual([]);
  });

  test("the hourly edit cap counts edit rows only", async () => {
    const w = await copyWorld();
    await w.t.run(async (ctx) => {
      for (let i = 0; i < MAX_COPY_PHOTO_EDITS_PER_HOUR; i++) {
        await ctx.db.insert("collectionCopyPhotos", {
          ownerId: OWNER,
          copyId: w.copyId,
          side: "back",
          token: i.toString(16).padStart(32, "0"),
          contentType: "image/jpeg",
          imageBytes: 1,
          thumbBytes: 1,
          status: "replaced",
          since: Date.now(),
          source: "edit",
        });
      }
    });
    await expect(
      w.me.action(api.photoEdits.saveCopyPhotoEdit, {
        copyId: w.copyId,
        side: "front",
        edit: { turns: 2, crop: null },
        expectToken: w.token,
        mode: "stored",
      }),
    ).rejects.toThrow(/photo edits for one hour/);
  });

  test("a client cannot finish an edit row through the hand-upload path", async () => {
    const w = await copyWorld();
    const { photoId } = await w.me.action(api.photoEdits.saveCopyPhotoEdit, {
      copyId: w.copyId,
      side: "front",
      edit: { turns: 2, crop: null },
      expectToken: w.token,
      mode: "stored",
    });
    expect(await w.t.query(internal.copyPhotos.pendingUpload, { ownerId: OWNER, photoId })).toBeNull();
    await drainScheduled(w.t);
  });
});
