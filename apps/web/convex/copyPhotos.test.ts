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
import { MAX_LINES_PER_CARD } from "./collection";
import { MAX_COPY_PHOTO_BYTES, MAX_COPY_PHOTO_UPLOADS_PER_HOUR, PHOTO_HOLD_MS, copyPhotoObjectKey } from "./copyPhotos";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { cancelScheduled } from "../lib/testing/drain-scheduled";
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

  test("a second photo on a side replaces the first, whose objects the sweep deletes an hour later", async () => {
    const s = await setup();
    vi.useFakeTimers();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    const first = (await photoRows(s))[0];
    await photograph(s, copyId, "front");
    const [photos] = await s.me.query(api.copyPhotos.photosOf, { copyIds: [copyId] });
    expect(photos.front?.thumbUrl).not.toContain(first.token);
    // The old one is no longer served, but waits for the sweep.
    expect((await photoRows(s)).map((r) => r.status).sort()).toEqual(["live", "replaced"]);
    vi.advanceTimersByTime(PHOTO_HOLD_MS + 1);
    expect(await s.t.mutation(internal.copyPhotos.sweepCopyPhotos, {})).toEqual({ pending: 0, detached: 0, replaced: 1 });
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

  test("NEO-427: a scanned pair's photos are outside the hourly cap, and don't eat into it", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    const seed = (source: "intake" | undefined, count: number, prefix: string) =>
      s.t.run(async (ctx) => {
        for (let i = 0; i < count; i++) {
          await ctx.db.insert("collectionCopyPhotos", {
            ownerId: ME.subject,
            copyId,
            side: "front",
            token: `${prefix}${i}`,
            contentType: "image/jpeg",
            imageBytes: 1,
            thumbBytes: 1,
            status: "pending",
            since: Date.now(),
            ...(source ? { source } : {}),
          });
        }
      });
    const reserve = (source?: "intake") =>
      s.t.mutation(internal.copyPhotos.reserveUpload, {
        ownerId: ME.subject,
        copyId,
        side: "front",
        contentType: "image/jpeg",
        imageBytes: 10,
        thumbBytes: 10,
        ...(source ? { source } : {}),
      });
    // A full hour of scanned photos: a hand upload still goes through...
    await seed("intake", MAX_COPY_PHOTO_UPLOADS_PER_HOUR, "scan");
    await expect(reserve()).resolves.toBeTruthy();
    // ...up to the cap, which then stops hands and never stops the scans.
    await seed(undefined, MAX_COPY_PHOTO_UPLOADS_PER_HOUR, "hand");
    await expect(reserve()).rejects.toThrow(/a lot of photos/);
    const { photoId } = await reserve("intake");
    expect((await s.t.run((ctx) => ctx.db.get(photoId)))?.source).toBe("intake");
  });

  test("NEO-427: a hand photo going live between a scanner's reserve and commit stays; the scanner's row goes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const s = await setup();
      const copyId = await addCopy(s);
      const { photoId: scanned, token } = await s.t.mutation(internal.copyPhotos.reserveUpload, {
        ownerId: ME.subject,
        copyId,
        side: "front",
        contentType: "image/jpeg",
        imageBytes: 300_000,
        thumbBytes: 20_000,
        source: "intake",
      });
      const hand = await photograph(s, copyId, "front");
      await expect(
        s.t.mutation(internal.copyPhotos.commitUpload, { ownerId: ME.subject, photoId: scanned }),
      ).resolves.toBeNull();
      const { kept, gone, queued } = await s.t.run(async (ctx) => ({
        kept: await ctx.db.get(hand),
        gone: await ctx.db.get(scanned),
        queued: await ctx.db.system.query("_scheduled_functions").collect(),
      }));
      expect(kept?.status).toBe("live");
      expect(gone).toBeNull();
      // Its files go with it.
      const deletes = queued.filter((f) => f.name.includes("deleteObjects"));
      expect(deletes.flatMap((f) => (f.args[0] as { keys: string[] }).keys)).toEqual([
        copyPhotoObjectKey(token, "image", "image/jpeg"),
        copyPhotoObjectKey(token, "thumb", "image/jpeg"),
      ]);
      await cancelScheduled(s.t as never);
    } finally {
      vi.useRealTimers();
    }
  });

  test("NEO-427: a collector cannot mark their own upload as a scanner's to dodge the cap", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await expect(
      s.me.action(api.copyPhotos.startUpload, {
        copyId,
        side: "front",
        contentType: "image/jpeg",
        imageBytes: 10,
        thumbBytes: 10,
        source: "intake",
      } as never),
    ).rejects.toThrow();
    expect(await photoRows(s)).toEqual([]);
  });

  test("NEO-427: hand uploads made before the field existed (no source) still count toward the cap", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await s.t.run(async (ctx) => {
      for (let i = 0; i < MAX_COPY_PHOTO_UPLOADS_PER_HOUR; i++) {
        await ctx.db.insert("collectionCopyPhotos", {
          ownerId: ME.subject,
          copyId,
          side: "back",
          token: `old${i}`,
          contentType: "image/jpeg",
          imageBytes: 1,
          thumbBytes: 1,
          status: "replaced",
          since: Date.now(),
        });
      }
    });
    await expect(photograph(s, copyId, "front")).rejects.toThrow(/a lot of photos/);
  });

  test("NEO-427: with the side free, a scanner's photo goes live", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    const { photoId } = await s.t.mutation(internal.copyPhotos.reserveUpload, {
      ownerId: ME.subject,
      copyId,
      side: "front",
      contentType: "image/jpeg",
      imageBytes: 300_000,
      thumbBytes: 20_000,
      source: "intake",
    });
    await s.t.mutation(internal.copyPhotos.commitUpload, { ownerId: ME.subject, photoId });
    expect((await s.t.run((ctx) => ctx.db.get(photoId)))?.status).toBe("live");
  });

  test("replacing one side over and over still meets the hourly cap", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    for (let i = 0; i < MAX_COPY_PHOTO_UPLOADS_PER_HOUR; i++) await photograph(s, copyId, "front");
    await expect(photograph(s, copyId, "front")).rejects.toThrow(/a lot of photos/);
  }, 60_000);

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

describe("editing a line", () => {
  test("saving the line's details keeps its photos", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    await photograph(s, copyId, "back");
    await s.me.mutation(api.collection.updateCopy, {
      copyId,
      details: { quantity: 1, condition: "Near Mint", notes: "corner ding" },
    });
    expect((await copyRow(s, copyId))?.hasPhotos).toBe(true);
    const [photos] = await s.me.query(api.copyPhotos.photosOf, { copyIds: [copyId] });
    expect(photos.front).toBeDefined();
    expect(photos.back).toBeDefined();
    const [card] = await s.me.query(api.copyPhotos.cardPhotos, { cardIds: [s.fx.gooden1] });
    expect(card.front).toBeDefined();
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

  test("NEO-431: an add whose photos follow it keeps its own line and pocket; a plain add still stacks", async () => {
    const s = await setup();
    const details = { quantity: 1, acquiredOn: "2026-11-01" };
    const plain = await addCopy(s, details);
    const own = await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.gooden1,
      details,
      keepsOwnLine: true,
    });
    expect(own.merged).toBe(false);
    expect(own.copyId).not.toBe(plain);
    const [first, second] = [await copyRow(s, plain), await copyRow(s, own.copyId)];
    expect(first?.quantity).toBe(1);
    // Not the twin's pocket, which would be refused as taken.
    expect(second?.slot).not.toBe(first?.slot);
    expect(second?.hasPhotos).toBeUndefined();

    const again = await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details });
    expect(again).toMatchObject({ copyId: plain, merged: true });
  });

  test("NEO-431: a box has no pockets, and keepsOwnLine still starts a line there", async () => {
    const s = await setup();
    const { containerId: box } = await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Show" });
    const details = { quantity: 1, homeId: box, acquiredOn: "2026-11-01" };
    const plain = await addCopy(s, details);
    const own = await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.gooden1,
      details,
      keepsOwnLine: true,
    });
    expect(own.merged).toBe(false);
    expect(own.copyId).not.toBe(plain);
  });

  test("NEO-431: keepsOwnLine on a card at the line limit is refused and writes nothing", async () => {
    const s = await setup();
    const copyId = await addCopy(s, { acquiredOn: "2026-11-01" });
    const row = await copyRow(s, copyId);
    await s.t.run(async (ctx) => {
      const { _id, _creationTime, ...rest } = row!;
      for (let i = 1; i < MAX_LINES_PER_CARD; i++) await ctx.db.insert("collectionCopies", { ...rest, slot: 1000 + i });
    });
    await expect(
      s.me.mutation(api.collection.addLineItem, {
        cardId: s.fx.gooden1,
        details: { quantity: 1, acquiredOn: "2026-11-01" },
        keepsOwnLine: true,
      }),
    ).rejects.toThrow(/lines of this card/);
    const lines = await s.t.run((ctx) => ctx.db.query("collectionCopies").collect());
    expect(lines).toHaveLength(MAX_LINES_PER_CARD);
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

  test("NEO-431: a replayed Undo refuses on a photo that is already live, and writes nothing", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    const { removed } = await s.me.mutation(api.collection.removeCopy, { copyId });
    const { copyId: back } = await s.me.mutation(api.collection.restoreCopy, removed);
    await expect(s.me.mutation(api.collection.restoreCopy, removed)).rejects.toThrow(/already back on a line/);
    const lines = await s.t.run(async (ctx) => await ctx.db.query("collectionCopies").collect());
    expect(lines.map((line) => line._id)).toEqual([back]);
    expect((await photoRows(s)).map((photo) => photo.copyId)).toEqual([back]);
  });

  test("NEO-431: an Undo naming the caller's pending or replaced photo skips it and the line comes back bare", async () => {
    const s = await setup();
    const copyId = await addCopy(s);
    const replaced = await photograph(s, copyId, "front");
    await photograph(s, copyId, "front");
    const { photoId: pending } = await s.t.mutation(internal.copyPhotos.reserveUpload, {
      ownerId: ME.subject,
      copyId,
      side: "back",
      contentType: "image/jpeg",
      imageBytes: 300_000,
      thumbBytes: 20_000,
    });
    const other = await addCopy(s, { grading: { grader: "PSA", grade: "9" } });
    const { removed } = await s.me.mutation(api.collection.removeCopy, { copyId: other });
    const { copyId: back } = await s.me.mutation(api.collection.restoreCopy, {
      ...removed,
      photoIds: [replaced, pending],
    });
    expect((await copyRow(s, back))?.hasPhotos).toBeUndefined();
    const rows = await photoRows(s);
    expect(rows.find((photo) => photo._id === replaced)?.status).toBe("replaced");
    expect(rows.find((photo) => photo._id === pending)?.status).toBe("pending");
    expect(rows.some((photo) => photo.copyId === back)).toBe(false);
  });

  test("NEO-431: an Undo naming a photo the sweep already took still brings the line back, bare", async () => {
    const s = await setup();
    vi.useFakeTimers();
    try {
      const copyId = await addCopy(s);
      await photograph(s, copyId, "front");
      const { removed } = await s.me.mutation(api.collection.removeCopy, { copyId });
      vi.advanceTimersByTime(PHOTO_HOLD_MS + 1);
      await s.t.mutation(internal.copyPhotos.sweepCopyPhotos, {});
      expect(await photoRows(s)).toEqual([]);
      const { copyId: back } = await s.me.mutation(api.collection.restoreCopy, removed);
      expect((await copyRow(s, back))?.hasPhotos).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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
    expect(swept).toEqual({ pending: 1, detached: 1, replaced: 0 });
    const rows = await photoRows(s);
    expect(rows.map((r) => r.status)).toEqual(["live"]);
    vi.useRealTimers();
  });

  test("NEO-431: a quick count's photos wait the same hour: inside it the Undo puts them back, past the sweep the line comes back bare", async () => {
    const s = await setup();
    vi.useFakeTimers();
    const box = (await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Box" })).containerId;
    const copyId = await addCopy(s, { homeId: box });
    const photoId = await photograph(s, copyId, "front");
    const count = (quantity: number) =>
      s.me.mutation(api.collectionInventory.setBoxQuantity, { cardId: s.fx.gooden1, boxId: box, quantity });

    const zero = await count(0);
    vi.advanceTimersByTime(PHOTO_HOLD_MS - 1000);
    expect(await s.t.mutation(internal.copyPhotos.sweepCopyPhotos, {})).toEqual({ pending: 0, detached: 0, replaced: 0 });
    await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: zero.inverse });
    const [back] = (await s.t.run((ctx) => ctx.db.query("collectionCopies").collect())).filter((r) => r.homeId === box);
    expect(back.hasPhotos).toBe(true);
    expect((await photoRows(s))[0]).toMatchObject({ _id: photoId, copyId: back._id, status: "live" });

    // A line brought back gets a fresh hour the next time it is counted away.
    const again = await count(0);
    vi.advanceTimersByTime(PHOTO_HOLD_MS + 1);
    expect(await s.t.mutation(internal.copyPhotos.sweepCopyPhotos, {})).toEqual({ pending: 0, detached: 1, replaced: 0 });
    await s.me.mutation(api.collectionInventory.undoBoxQuantity, { inverse: again.inverse });
    const [bare] = (await s.t.run((ctx) => ctx.db.query("collectionCopies").collect())).filter((r) => r.homeId === box);
    expect(bare.quantity).toBe(1);
    expect(bare.hasPhotos).toBeUndefined();
    expect(await photoRows(s)).toEqual([]);
    vi.useRealTimers();
  });

  test("the global reset drains every photo, with its objects, before the copies", async () => {
    const s = await setup();
    vi.stubEnv("ALLOW_RESET_SET_BUILDER_DATA", "true");
    const copyId = await addCopy(s);
    await photograph(s, copyId, "front");
    await photograph(s, copyId, "back");
    expect(await s.t.mutation(internal.selectorOptions.resetCollectionCopiesBatch, {})).toEqual({
      deleted: 0,
      hasMore: true,
    });
    expect(await photoRows(s)).toEqual([]);
    expect(await copyRow(s, copyId)).not.toBeNull();
    const scheduled = await s.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.flatMap((f) => (f.args[0] as { keys?: string[] }).keys ?? [])).toHaveLength(4);
    const next = await s.t.mutation(internal.selectorOptions.resetCollectionCopiesBatch, {});
    expect(next.deleted).toBeGreaterThan(0);
    expect(await copyRow(s, copyId)).toBeNull();
    vi.unstubAllEnvs();
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

describe("NEO-432: a photo change queues the card only when the copy's home lists", () => {
  const outboxRows = (s: S) => s.t.run(async (ctx) => await ctx.db.query("listingOutbox").collect());

  /** The owner pushes counts to both platforms (`listingOutbox.pushesCounts`). */
  const listEverywhere = (s: S) =>
    s.t.run(async (ctx) => {
      for (const platform of ["bsc", "ebay"] as const) {
        await ctx.db.insert("marketplaceListingStates", {
          ownerId: ME.subject,
          platform,
          listingStartedAt: 1,
          lastUpdated: 0,
        });
      }
    });

  async function makeHome(s: S, home: "binder" | "listed box" | "in-person box"): Promise<Id<"collectionContainers">> {
    const { containerId } = await s.me.mutation(api.collectionContainers.create, {
      kind: home === "binder" ? "binder" : "box",
      name: home,
    });
    if (home === "in-person box") {
      await s.me.mutation(api.collectionContainers.setContainerListed, { containerId, listed: false });
    }
    return containerId;
  }

  /** One photo change, and proof it really happened: a no-op would queue nothing either. */
  const CHANGES = [
    {
      name: "commitUpload",
      photographedFirst: false,
      change: async (s: S, copyId: Id<"collectionCopies">) => {
        await photograph(s, copyId, "front");
        expect((await copyRow(s, copyId))?.hasPhotos).toBe(true);
      },
    },
    {
      name: "remove",
      photographedFirst: true,
      change: async (s: S, copyId: Id<"collectionCopies">) => {
        await s.me.mutation(api.copyPhotos.remove, { copyId, side: "front" });
        expect((await copyRow(s, copyId))?.hasPhotos).toBeUndefined();
      },
    },
    {
      name: "swap",
      photographedFirst: true,
      change: async (s: S, copyId: Id<"collectionCopies">) => {
        await s.me.mutation(api.copyPhotos.swap, { copyId });
        expect((await photoRows(s))[0].side).toBe("back");
      },
    },
  ];

  /**
   * A copy in `homeId`, with its photo when the change needs one. Both are
   * written before the owner lists, so the outbox holds only what the change
   * under test writes.
   */
  async function listedOwnerCopy(
    s: S,
    homeId: Id<"collectionContainers">,
    photographedFirst: boolean,
  ): Promise<Id<"collectionCopies">> {
    const copyId = await addCopy(s, { homeId });
    if (photographedFirst) await photograph(s, copyId, "front");
    await listEverywhere(s);
    expect(await outboxRows(s)).toEqual([]);
    return copyId;
  }

  test.each(CHANGES)("$name on a binder copy queues nothing", async ({ photographedFirst, change }) => {
    const s = await setup();
    const copyId = await listedOwnerCopy(s, await makeHome(s, "binder"), photographedFirst);
    await change(s, copyId);
    expect(await outboxRows(s)).toEqual([]);
  });

  test.each(CHANGES)("$name on an in-person box copy queues nothing", async ({ photographedFirst, change }) => {
    const s = await setup();
    const copyId = await listedOwnerCopy(s, await makeHome(s, "in-person box"), photographedFirst);
    await change(s, copyId);
    expect(await outboxRows(s)).toEqual([]);
  });

  test.each(CHANGES)("$name on a listed box copy queues the card on every platform", async ({ photographedFirst, change }) => {
    const s = await setup();
    const copyId = await listedOwnerCopy(s, await makeHome(s, "listed box"), photographedFirst);
    await change(s, copyId);
    const rows = await outboxRows(s);
    expect(rows.map((r) => r.platform).sort()).toEqual(["bsc", "ebay"]);
    expect(rows.every((r) => r.cardId === s.fx.gooden1 && r.ownerId === ME.subject)).toBe(true);
  });

  test("a copy pointing at another collector's listed box queues nothing", async () => {
    const s = await setup();
    const copyId = await listedOwnerCopy(s, await makeHome(s, "binder"), false);
    const { containerId: theirBox } = await s.them.mutation(api.collectionContainers.create, {
      kind: "box",
      name: "Their box",
    });
    await s.t.run(async (ctx) => await ctx.db.patch(copyId, { homeId: theirBox }));
    await photograph(s, copyId, "front");
    expect(await outboxRows(s)).toEqual([]);
  });
});
