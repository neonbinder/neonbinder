/**
 * NEO-377 — photos of a collector's own copies (`convex/copyPhotos.ts`): an
 * upload goes pending → live on its side (replacing the old one), only the
 * owner sees or changes it, a line with photos never folds, removing the
 * copy detaches them for the Undo, and the sweep clears what was left.
 *
 * R2 itself is not reached here: the database halves (`reserveUpload`,
 * `commitUpload`) are driven directly, and `startUpload` / `finishUpload`
 * are checked to refuse when R2 isn't configured.
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { MAX_COPY_PHOTO_BYTES, MAX_COPY_PHOTO_UPLOADS_PER_HOUR, PHOTO_HOLD_MS, copyPhotoObjectKey } from "./copyPhotos";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import type { Id } from "./_generated/dataModel";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };

async function setup() {
  vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, me: t.withIdentity(ME), them: t.withIdentity(THEM) };
}
type S = Awaited<ReturnType<typeof setup>>;

async function addCopy(s: S, details: Record<string, unknown> = {}): Promise<Id<"collectionCopies">> {
  const { copyId } = await s.me.mutation(api.collection.addLineItem, {
    cardId: s.fx.gooden1,
    details: { quantity: 1, ...details },
  });
  return copyId;
}

/** Steps 1 and 3 of an upload, without R2 in between. */
async function photograph(
  s: S,
  copyId: Id<"collectionCopies">,
  side: "front" | "back",
  ownerId = ME.subject,
): Promise<Id<"collectionCopyPhotos">> {
  const { photoId } = await s.t.mutation(internal.copyPhotos.reserveUpload, {
    ownerId,
    copyId,
    side,
    contentType: "image/jpeg",
    imageBytes: 300_000,
    thumbBytes: 20_000,
  });
  await s.t.mutation(internal.copyPhotos.commitUpload, { ownerId, photoId });
  return photoId;
}

const photoRows = (s: S) => s.t.run(async (ctx) => await ctx.db.query("collectionCopyPhotos").collect());
const copyRow = (s: S, id: Id<"collectionCopies">) => s.t.run(async (ctx) => await ctx.db.get(id));

describe("upload", () => {
  test("a finished upload goes live on its side and the line is marked", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    expect((await copyRow(s, copyId))?.hasPhotos).toBe(true);
    const [photos] = await s.me.query(api.copyPhotos.photosOf, { copyIds: [copyId] });
    expect(photos.front?.imageUrl).toMatch(/^https:\/\/example\.convex\.site\/copy-photo\/[0-9a-f]{32}\/image$/);
    expect(photos.front?.thumbUrl).toMatch(/\/thumb$/);
    expect(photos.back).toBeUndefined();
    const copies = await s.me.query(api.collection.copiesOf, { cardId: s.fx.gooden1 });
    expect(copies[0].hasPhotos).toBe(true);
  });

  test("a second photo on a side replaces the first, and its objects are deleted", async () => {
    const s = await setup();
    vi.useFakeTimers();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    const first = (await photoRows(s))[0];
    await photograph(s, copyId, "front");
    const rows = await photoRows(s);
    expect(rows).toHaveLength(1);
    expect(rows[0].token).not.toBe(first.token);
    const scheduled = await s.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.map((f) => f.args[0])).toContainEqual({
      keys: [copyPhotoObjectKey(first.token, "image", "image/jpeg"), copyPhotoObjectKey(first.token, "thumb", "image/jpeg")],
    });
    vi.useRealTimers();
  });

  test("refuses another collector's copy, oversize files, and past the hourly cap", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await expect(photograph(s, copyId, "front", THEM.subject)).rejects.toThrow(/isn't in your collection/);
    await expect(
      s.t.mutation(internal.copyPhotos.reserveUpload, {
        ownerId: ME.subject,
        copyId,
        side: "front",
        contentType: "image/jpeg",
        imageBytes: MAX_COPY_PHOTO_BYTES + 1,
        thumbBytes: 1,
      }),
    ).rejects.toThrow(/too big/);
    await s.t.run(async (ctx) => {
      for (let i = 0; i < MAX_COPY_PHOTO_UPLOADS_PER_HOUR; i++) {
        await ctx.db.insert("collectionCopyPhotos", {
          ownerId: ME.subject,
          copyId,
          side: "front",
          token: `t${i}`,
          contentType: "image/jpeg",
          imageBytes: 1,
          thumbBytes: 1,
          status: "pending",
          since: Date.now(),
        });
      }
    });
    await expect(photograph(s, copyId, "back")).rejects.toThrow(/a lot of photos/);
  });

  test("a pending upload can't be committed by someone else, or twice", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    const photoId = await photograph(s, copyId, "front");
    await expect(
      s.t.mutation(internal.copyPhotos.commitUpload, { ownerId: ME.subject, photoId }),
    ).rejects.toThrow(/ran out of time/);
    await expect(
      s.t.mutation(internal.copyPhotos.commitUpload, { ownerId: THEM.subject, photoId }),
    ).rejects.toThrow(/ran out of time/);
  });

  test("the public actions refuse when R2 isn't set up, and when signed out", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    const args = { copyId, side: "front" as const, contentType: "image/jpeg" as const, imageBytes: 10, thumbBytes: 10 };
    await expect(s.t.action(api.copyPhotos.startUpload, args)).rejects.toThrow(/Not authenticated/);
    await expect(s.me.action(api.copyPhotos.startUpload, args)).rejects.toThrow(/aren't set up/);
  });
});

describe("reading and removing", () => {
  test("only the owner reads or removes a line's photos", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    expect(await s.them.query(api.copyPhotos.photosOf, { copyIds: [copyId] })).toEqual([]);
    expect(await s.t.query(api.copyPhotos.photosOf, { copyIds: [copyId] })).toEqual([]);
    await expect(s.them.mutation(api.copyPhotos.remove, { copyId, side: "front" })).rejects.toThrow(
      /isn't in your collection/,
    );
  });

  test("removing the last side clears the mark; one side left keeps it", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    await photograph(s, copyId, "back");
    await s.me.mutation(api.copyPhotos.remove, { copyId, side: "front" });
    expect((await copyRow(s, copyId))?.hasPhotos).toBe(true);
    await s.me.mutation(api.copyPhotos.remove, { copyId, side: "back" });
    expect((await copyRow(s, copyId))?.hasPhotos).toBeUndefined();
    expect(await photoRows(s)).toEqual([]);
  });

  test("the redirect serves live photos only, and checks the path first", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    const { token } = (await photoRows(s))[0];
    // R2 isn't configured here, so even a live photo is a 404; the point is
    // that nothing malformed reaches the database.
    for (const path of [`/copy-photo/${token}/image`, "/copy-photo/../x/image", `/copy-photo/${token}/full`]) {
      const res = await s.t.fetch(path, { method: "GET" });
      expect(res.status).toBe(404);
    }
  });
});

describe("swap and the card's picture", () => {
  test("swap trades the sides, owner only", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    const front = await photograph(s, copyId, "front");
    await expect(s.them.mutation(api.copyPhotos.swap, { copyId })).rejects.toThrow(/isn't in your collection/);
    await s.me.mutation(api.copyPhotos.swap, { copyId });
    expect((await photoRows(s)).find((r) => r._id === front)?.side).toBe("back");
  });

  test("cardPhotos: the first line with a front stands for the card, the caller's own only", async () => {
    const s = await setup();
    const backOnly = await addCopy(s, { notes: "first" });
    const withFront = await addCopy(s, { notes: "second" });
    await photograph(s, backOnly, "back");
    await photograph(s, withFront, "front");
    const [pick] = await s.me.query(api.copyPhotos.cardPhotos, { cardIds: [s.fx.gooden1] });
    expect(pick.cardId).toBe(s.fx.gooden1);
    expect(pick.front?.thumbUrl).toMatch(/^https:\/\/example\.convex\.site\/copy-photo\/[0-9a-f]{32}\/thumb$/);
    expect(pick.back).toBeUndefined();
    expect(await s.them.query(api.copyPhotos.cardPhotos, { cardIds: [s.fx.gooden1] })).toEqual([]);
    expect(await s.t.query(api.copyPhotos.cardPhotos, { cardIds: [s.fx.gooden1] })).toEqual([]);
    expect(await s.me.query(api.copyPhotos.cardPhotos, { cardIds: ["not-an-id"] })).toEqual([]);
  });

  test("cardPhotos: a back alone stands in when no line has a front", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "back");
    const [pick] = await s.me.query(api.copyPhotos.cardPhotos, { cardIds: [s.fx.gooden1] });
    expect(pick.back).toBeTruthy();
    expect(pick.front).toBeUndefined();
  });
});

describe("folds, removes and undo", () => {
  test("a line with photos never folds, either way", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    const { copyId: second, merged } = await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.gooden1,
      details: { quantity: 1 },
    });
    expect(merged).toBe(false);
    expect(second).not.toBe(copyId);
  });

  test("moving a whole photographed line keeps its photos and never stacks on a twin", async () => {
    const s = await setup();
    const { containerId: binder } = await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "B" });
    const twin = await addCopy(s, { homeId: binder });
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    const moved = await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: binder });
    expect(moved.folded).toBe(false);
    expect(moved.copyId).toBe(copyId);
    expect((await copyRow(s, twin))?.quantity).toBe(1);
    expect((await copyRow(s, copyId))?.hasPhotos).toBe(true);
  });

  test("part of a photographed stack splits off without the photos", async () => {
    const s = await setup();
    const copyId = await addCopy(s, { quantity: 3 });
    await photograph(s, copyId, "front");
    const { containerId: binder } = await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "B" });
    const moved = await s.me.mutation(api.collection.moveCopy, { copyId, toHomeId: binder, quantity: 1 });
    expect(moved.split).toBe(true);
    expect((await copyRow(s, moved.copyId))?.hasPhotos).toBeUndefined();
    expect((await copyRow(s, copyId))?.hasPhotos).toBe(true);
  });

  test("remove detaches the photos and its Undo puts them back", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    const { removed } = await s.me.mutation(api.collection.removeCopy, { copyId });
    expect(removed.photoIds).toHaveLength(1);
    expect((await photoRows(s))[0].status).toBe("detached");
    const { copyId: back } = await s.me.mutation(api.collection.restoreCopy, removed);
    expect((await copyRow(s, back))?.hasPhotos).toBe(true);
    const [photos] = await s.me.query(api.copyPhotos.photosOf, { copyIds: [back] });
    expect(photos.front).toBeDefined();
  });

  test("another collector can't take detached photos with a forged Undo", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    const { removed } = await s.me.mutation(api.collection.removeCopy, { copyId });
    const { copyId: theirs } = await s.them.mutation(api.collection.addLineItem, {
      cardId: s.fx.gooden1,
      details: { quantity: 1 },
    });
    const theirHome = (await copyRow(s, theirs))!.homeId;
    const { copyId: restored } = await s.them.mutation(api.collection.restoreCopy, {
      ...removed,
      details: { ...removed.details, homeId: theirHome },
    });
    expect((await copyRow(s, restored))?.hasPhotos).toBeUndefined();
    expect((await photoRows(s))[0].status).toBe("detached");
  });

  test("the sweep clears stale pending and detached photos, not live ones", async () => {
    const s = await setup();
    vi.useFakeTimers();
    const live = await addCopy(s);
    await photograph(s, live, "front");
    const gone = await addCopy(s, { notes: "other line" });
    await photograph(s, gone, "front");
    await s.me.mutation(api.collection.removeCopy, { copyId: gone });
    await s.t.mutation(internal.copyPhotos.reserveUpload, {
      ownerId: ME.subject,
      copyId: live,
      side: "back",
      contentType: "image/webp",
      imageBytes: 1,
      thumbBytes: 1,
    });
    vi.advanceTimersByTime(PHOTO_HOLD_MS + 1);
    const swept = await s.t.mutation(internal.copyPhotos.sweepCopyPhotos, {});
    expect(swept).toEqual({ pending: 1, detached: 1 });
    const rows = await photoRows(s);
    expect(rows.map((r) => r.status)).toEqual(["live"]);
    vi.useRealTimers();
  });

  test("the per-account test reset takes the caller's photos with their copies", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    await s.t.run(async (ctx) => {
      const { dropOwnerPhotos } = await import("./copyPhotos");
      expect(await dropOwnerPhotos(ctx, ME.subject)).toBe(1);
    });
    expect(await photoRows(s)).toEqual([]);
  });
});
