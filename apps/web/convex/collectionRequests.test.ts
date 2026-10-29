/**
 * NEO-361 — card and set requests (`convex/collectionRequests.ts`): a request
 * makes a private card the collector can own at once; an approval moves
 * their copies onto the NB card; a decline leaves it theirs; a withdraw
 * deletes it with every copy; a set approval matches only on an exactly-one
 * card number; and nobody else ever reads or files another collector's
 * private card.
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { MAX_PHOTO_UPLOADS_PER_HOUR, PHOTO_UPLOAD_TTL_MS } from "./collectionRequests";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import { insertTestCard } from "../lib/testing/card-row";
import type { Id } from "./_generated/dataModel";

/**
 * A stored upload with a content type. Real Convex records the POST's
 * Content-Type; convex-test's storage records none, so it is written onto the
 * system row here.
 */
async function storePhoto(s: { t: ReturnType<typeof convexTest> }, contentType: string): Promise<Id<"_storage">> {
  return await s.t.run(async (ctx) => {
    const id = await ctx.storage.store(new Blob([contentType], { type: contentType }));
    await (ctx.db as unknown as { patch: (id: Id<"_storage">, v: object) => Promise<void> }).patch(id, { contentType });
    return id;
  });
}

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };
const ADMIN = { subject: "user_admin", role: "admin" };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  return { t, fx, me: t.withIdentity(ME), them: t.withIdentity(THEM), admin: t.withIdentity(ADMIN) };
}
type S = Awaited<ReturnType<typeof setup>>;

/** A card request for #7 "Mike Piazza" in the fixture's Topps Chrome Base. */
const askBase = (s: S, extra: Record<string, unknown> = {}, who = s.me) =>
  who.mutation(api.collectionRequests.requestCard, {
    setId: s.fx.setId,
    variantId: s.fx.baseId,
    cardNumber: "#7",
    player: "Mike Piazza",
    ...extra,
  });

const copies = (s: S, ownerId = ME.subject) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("collectionCopies").collect()).filter((c) => c.ownerId === ownerId),
  );

const tallyOf = (s: S, who = s.me) => who.query(api.collection.summary, {});

describe("auth", () => {
  test("collector functions refuse a signed-out caller", async () => {
    const s = await setup();
    await expect(s.t.query(api.collectionRequests.mine, {})).rejects.toThrow(/Not authenticated/);
    await expect(askBase(s, {}, s.t as never)).rejects.toThrow(/Not authenticated/);
    await expect(s.t.mutation(api.collectionRequests.generateUploadUrl, {})).rejects.toThrow(
      /Not authenticated/,
    );
  });

  test("review functions are admin-only", async () => {
    const s = await setup();
    const { requestId } = await askBase(s);
    await expect(s.me.query(api.collectionRequests.queue, {})).rejects.toThrow(/Admin access required/);
    await expect(s.me.query(api.collectionRequests.waitingCount, {})).rejects.toThrow(/Admin access required/);
    await expect(s.me.query(api.collectionRequests.review, { requestId })).rejects.toThrow(/Admin access required/);
    await expect(
      s.me.mutation(api.collectionRequests.approveCard, { requestId, cardId: s.fx.gooden1 }),
    ).rejects.toThrow(/Admin access required/);
    await expect(s.me.mutation(api.collectionRequests.decline, { requestId })).rejects.toThrow(
      /Admin access required/,
    );
  });
});

describe("requestCard", () => {
  test("makes a waiting request and the collector's private card, number without its #", async () => {
    const s = await setup();
    const { requestId, privateCardId } = await askBase(s, { notes: "  gold foil  ", searched: "piazza 7" });
    const mine = await s.me.query(api.collectionRequests.mine, {});
    expect(mine).toEqual([
      expect.objectContaining({
        _id: requestId,
        kind: "card",
        status: "waiting",
        label: "2024 Topps Chrome #7 Mike Piazza",
        notes: "gold foil",
        privateCardId,
        copies: 0,
        cards: 1,
      }),
    ]);
    const [card] = await s.me.query(api.collectionRequests.privateCards, { ids: [privateCardId] });
    expect(card).toMatchObject({
      _id: privateCardId,
      status: "waiting",
      cardNumber: "7",
      player: "Mike Piazza",
      set: expect.objectContaining({ _id: s.fx.setId, name: "Topps Chrome" }),
      variant: expect.objectContaining({ _id: s.fx.baseId, kind: "base" }),
      privateSet: null,
    });
    const request = await s.t.run((ctx) => ctx.db.get(requestId));
    expect(request?.searched).toBe("piazza 7");
  });

  test("a checklist that isn't listed is typed, and lands in the label", async () => {
    const s = await setup();
    await askBase(s, { variantId: undefined, variantName: "Atomic Refractor" });
    const [mine] = await s.me.query(api.collectionRequests.mine, {});
    expect(mine.label).toBe("2024 Topps Chrome Atomic Refractor #7 Mike Piazza");
  });

  test("refuses a missing set, number, player or checklist, and a checklist from another set", async () => {
    const s = await setup();
    await expect(askBase(s, { setId: s.fx.baseId })).rejects.toThrow(/isn't in the catalog/);
    await expect(askBase(s, { cardNumber: " # " })).rejects.toThrow(/Add the card number/);
    await expect(askBase(s, { player: "  " })).rejects.toThrow(/Add the player/);
    await expect(askBase(s, { variantId: undefined })).rejects.toThrow(/Pick the checklist/);
    await expect(askBase(s, { setId: s.fx.set86Id })).rejects.toThrow(/isn't in this set/);
    expect(await s.t.run((ctx) => ctx.db.query("cardRequests").collect())).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("privateCards").collect())).toEqual([]);
  });

  test("a photo must have finished uploading, and the owner reads it back", async () => {
    const s = await setup();
    const png = await storePhoto(s, "image/png");
    const gone = await s.t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(["y"]));
      await ctx.storage.delete(id);
      return id;
    });
    await expect(askBase(s, { frontImageId: gone })).rejects.toThrow(/didn't finish uploading/);
    const { privateCardId } = await askBase(s, { frontImageId: png });
    const [card] = await s.me.query(api.collectionRequests.privateCards, { ids: [privateCardId] });
    expect(card?.frontImageUrl).toEqual(expect.any(String));
    // One photo, one card: a reused id (someone else's, say) is refused.
    await expect(askBase(s, { cardNumber: "2", backImageId: png })).rejects.toThrow(/already on a card/);
  });

  test("a photo must be a photo type: never SVG, never untyped", async () => {
    const s = await setup();
    const svg = await storePhoto(s, "image/svg+xml");
    const untyped = await s.t.run((ctx) => ctx.storage.store(new Blob(["x"])));
    await expect(askBase(s, { frontImageId: svg })).rejects.toThrow(/isn't a photo/);
    await expect(askBase(s, { frontImageId: untyped })).rejects.toThrow(/isn't a photo/);
    expect(await s.t.run((ctx) => ctx.db.query("privateCards").collect())).toEqual([]);
  });

  test("upload URLs are capped per hour, and the sweep clears unattached photos and old tickets", async () => {
    vi.useFakeTimers();
    try {
      const s = await setup();
      for (let i = 0; i < MAX_PHOTO_UPLOADS_PER_HOUR; i++) {
        await s.me.mutation(api.collectionRequests.generateUploadUrl, {});
      }
      await expect(s.me.mutation(api.collectionRequests.generateUploadUrl, {})).rejects.toThrow(/a lot of photos/);
      // Someone else's hour is their own.
      await expect(s.them.mutation(api.collectionRequests.generateUploadUrl, {})).resolves.toEqual(expect.any(String));

      const kept = await storePhoto(s, "image/png");
      const orphan = await storePhoto(s, "image/png");
      await askBase(s, { frontImageId: kept });
      vi.advanceTimersByTime(PHOTO_UPLOAD_TTL_MS + 1000);
      const swept = await s.t.mutation(internal.collectionRequests.sweepPhotoUploads, {});
      expect(swept).toEqual({ tickets: MAX_PHOTO_UPLOADS_PER_HOUR + 1, photos: 1 });
      expect(await s.t.run((ctx) => ctx.db.system.get(orphan))).toBeNull();
      expect(await s.t.run((ctx) => ctx.db.system.get(kept))).not.toBeNull();
      // A new hour, new URLs.
      await expect(s.me.mutation(api.collectionRequests.generateUploadUrl, {})).resolves.toEqual(expect.any(String));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("owning a private card", () => {
  test("files copies at once, outside every checklist and set count", async () => {
    const s = await setup();
    const { privateCardId } = await askBase(s);
    await s.me.mutation(api.collection.addHave, { cardId: privateCardId });
    await s.me.mutation(api.collection.addHave, { cardId: privateCardId });
    const [row] = await copies(s);
    expect(row).toMatchObject({ cardId: privateCardId, quantity: 2 });
    expect(row.variantId).toBeUndefined();
    expect(row.setId).toBeUndefined();
    expect(await tallyOf(s)).toMatchObject({ copies: 2, lines: 1, distinctCards: 1 });
    expect(await s.me.query(api.collection.copiesOf, { cardId: privateCardId })).toHaveLength(1);
    const completion = await s.me.query(api.collection.setCompletion, { setId: s.fx.setId });
    expect(completion.owned).toBe(0);
    expect(await s.me.query(api.collection.copiesInVariant, { variantId: s.fx.baseId })).toEqual([]);
  });

  test("another collector can neither read nor file it", async () => {
    const s = await setup();
    const { privateCardId, requestId } = await askBase(s);
    await expect(s.them.mutation(api.collection.addHave, { cardId: privateCardId })).rejects.toThrow(
      /isn't in your collection/,
    );
    expect(await s.them.query(api.collectionRequests.privateCards, { ids: [privateCardId] })).toEqual([null]);
    expect(await s.them.query(api.collection.copiesOf, { cardId: privateCardId })).toEqual([]);
    expect(await s.them.query(api.collectionRequests.mine, {})).toEqual([]);
    await expect(s.them.mutation(api.collectionRequests.withdraw, { requestId })).rejects.toThrow(
      /isn't one of yours/,
    );
  });
});

describe("decline", () => {
  test("leaves the card theirs, with the admin's note", async () => {
    const s = await setup();
    const { requestId, privateCardId } = await askBase(s);
    await s.admin.mutation(api.collectionRequests.decline, { requestId, note: "Not a licensed issue" });
    const [mine] = await s.me.query(api.collectionRequests.mine, {});
    expect(mine).toMatchObject({ status: "declined", decisionNote: "Not a licensed issue" });
    await s.me.mutation(api.collection.addHave, { cardId: privateCardId });
    const [card] = await s.me.query(api.collectionRequests.privateCards, { ids: [privateCardId] });
    expect(card?.status).toBe("declined");
    expect(await copies(s)).toHaveLength(1);
    await expect(s.admin.mutation(api.collectionRequests.decline, { requestId })).rejects.toThrow(
      /isn't waiting/,
    );
  });
});

describe("approveCard", () => {
  test("moves every copy onto the NB card in place and drops the private card", async () => {
    const s = await setup();
    const binderId = (await s.me.mutation(api.collectionContainers.create, { kind: "binder", name: "PC" }))
      .containerId;
    const { requestId, privateCardId } = await askBase(s);
    const { copyId } = await s.me.mutation(api.collection.addLineItem, {
      cardId: privateCardId,
      details: { quantity: 1, homeId: binderId, slot: 4, condition: "Mint" },
    });
    await s.me.mutation(api.collection.setTrade, { copyId, on: true });
    const newCard = await s.t.run((ctx) =>
      insertTestCard(ctx, { selectorOptionId: s.fx.baseId, cardNumber: "7", cardName: "Mike Piazza", platformData: {}, sortOrder: 9, lastUpdated: 1 }),
    );
    expect(
      await s.admin.mutation(api.collectionRequests.approveCard, { requestId, cardId: newCard, note: "Added!" }),
    ).toEqual({ moved: 1 });
    const [row] = await copies(s);
    expect(row).toMatchObject({
      _id: copyId,
      cardId: newCard,
      variantId: s.fx.baseId,
      setId: s.fx.setId,
      homeId: binderId,
      slot: 4,
      upForTrade: true,
      condition: "Mint",
    });
    expect(await s.t.run((ctx) => ctx.db.get(privateCardId))).toBeNull();
    const [mine] = await s.me.query(api.collectionRequests.mine, {});
    expect(mine).toMatchObject({ status: "added", addedCardId: newCard, decisionNote: "Added!", cards: 0 });
    expect(await tallyOf(s)).toMatchObject({ copies: 1, lines: 1, distinctCards: 1 });
    const completion = await s.me.query(api.collection.setCompletion, { setId: s.fx.setId });
    expect(completion.ownedAll).toBe(1);
  });

  test("folds into an identical line of a card they already held, into its pocket (NEO-359)", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1, acquiredOn: "2024-01-02" });
    const { requestId, privateCardId } = await askBase(s, { cardNumber: "1", player: "Doc Gooden" });
    await s.me.mutation(api.collection.addHave, { cardId: privateCardId, acquiredOn: "2024-01-02" });
    expect(await tallyOf(s)).toMatchObject({ copies: 2, lines: 2, distinctCards: 2 });
    const before = await copies(s);
    const held = before.find((row) => row.cardId === s.fx.gooden1)!;
    expect(before.find((row) => row.cardId === privateCardId)?.slot).not.toBe(held.slot);
    await s.admin.mutation(api.collectionRequests.approveCard, { requestId, cardId: s.fx.gooden1 });
    const rows = await copies(s);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cardId: s.fx.gooden1, quantity: 2, slot: held.slot });
    expect(await tallyOf(s)).toMatchObject({ copies: 2, lines: 1, distinctCards: 1 });
  });

  test("a copy kept in a box counts on the inventory side only, and joins the NB card on approval (NEO-364)", async () => {
    const s = await setup();
    const boxId = (await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Box A" })).containerId;
    const { requestId, privateCardId } = await askBase(s);
    await s.me.mutation(api.collection.addLineItem, {
      cardId: privateCardId,
      details: { quantity: 3, homeId: boxId },
    });
    // The collection tally is binders only; the box keeps its own count.
    expect(await tallyOf(s)).toMatchObject({ copies: 0, lines: 0, distinctCards: 0 });
    const box = async () =>
      (await s.me.query(api.collectionContainers.list, {})).find((c) => c._id === boxId);
    expect((await box())?.count).toMatchObject({ copies: 3, lines: 1 });
    // The Inventory list is of catalog cards: the private one is not listed.
    expect((await s.me.query(api.collectionInventory.inventoryCards, {})).items).toEqual([]);
    await s.admin.mutation(api.collectionRequests.approveCard, { requestId, cardId: s.fx.gooden1 });
    const listed = (await s.me.query(api.collectionInventory.inventoryCards, {})).items;
    expect(listed.map((i) => [i.cardId, i.quantity])).toEqual([[s.fx.gooden1, 3]]);
    expect((await box())?.count).toMatchObject({ copies: 3, lines: 1 });
    expect(await tallyOf(s)).toMatchObject({ copies: 0, lines: 0, distinctCards: 0 });
  });

  test("refuses a set request and an already added one", async () => {
    const s = await setup();
    const { requestId } = await askBase(s);
    await s.admin.mutation(api.collectionRequests.approveCard, { requestId, cardId: s.fx.gooden1 });
    await expect(
      s.admin.mutation(api.collectionRequests.approveCard, { requestId, cardId: s.fx.gooden1 }),
    ).rejects.toThrow(/already added/);
    const set = await s.me.mutation(api.collectionRequests.requestSet, {
      sportId: s.fx.sportId, year: "1952", brand: "Bowman", name: "Bowman",
    });
    await expect(
      s.admin.mutation(api.collectionRequests.approveCard, { requestId: set.requestId, cardId: s.fx.gooden1 }),
    ).rejects.toThrow(/set request/);
  });
});

describe("withdraw", () => {
  test("deletes the request, the private card and every copy, and the tally follows", async () => {
    const s = await setup();
    await s.me.mutation(api.collection.addHave, { cardId: s.fx.gooden1 });
    const { requestId, privateCardId } = await askBase(s);
    await s.me.mutation(api.collection.addHave, { cardId: privateCardId });
    await s.me.mutation(api.collection.addHave, { cardId: privateCardId });
    const [mine] = await s.me.query(api.collectionRequests.mine, {});
    expect(mine.copies).toBe(2);
    expect(await s.me.mutation(api.collectionRequests.withdraw, { requestId })).toEqual({ copies: 2, cards: 1 });
    expect(await s.me.query(api.collectionRequests.mine, {})).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.get(privateCardId))).toBeNull();
    expect((await copies(s)).map((c) => c.cardId)).toEqual([s.fx.gooden1]);
    expect(await tallyOf(s)).toMatchObject({ copies: 1, lines: 1, distinctCards: 1 });
  });

  test("withdrawing deletes the photos of the private card's copies, with their objects", async () => {
    const s = await setup();
    const { requestId, privateCardId } = await askBase(s);
    await s.me.mutation(api.collection.addHave, { cardId: privateCardId });
    const [copy] = await copies(s);
    const { photoId } = await s.t.mutation(internal.copyPhotos.reserveUpload, {
      ownerId: ME.subject,
      copyId: copy._id,
      side: "front",
      contentType: "image/jpeg",
      imageBytes: 10,
      thumbBytes: 10,
    });
    await s.t.mutation(internal.copyPhotos.commitUpload, { ownerId: ME.subject, photoId });
    await s.me.mutation(api.collectionRequests.withdraw, { requestId });
    expect(await s.t.run((ctx) => ctx.db.query("collectionCopyPhotos").collect())).toEqual([]);
    const scheduled = await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.flatMap((f) => (f.args[0] as { keys?: string[] }).keys ?? [])).toHaveLength(2);
  });

  test("an added request has nothing to withdraw", async () => {
    const s = await setup();
    const { requestId } = await askBase(s);
    await s.admin.mutation(api.collectionRequests.approveCard, { requestId, cardId: s.fx.gooden1 });
    await expect(s.me.mutation(api.collectionRequests.withdraw, { requestId })).rejects.toThrow(
      /nothing to withdraw/,
    );
  });
});

describe("set requests", () => {
  async function askSet(s: S) {
    const { requestId, privateSetId } = await s.me.mutation(api.collectionRequests.requestSet, {
      sportId: s.fx.sportId,
      year: "1986",
      brand: "Topps",
      name: "Topps Traded",
      notes: "Checklist: tradingcarddb",
    });
    const add = (cardNumber: string, player: string) =>
      s.me.mutation(api.collectionRequests.addPrivateCard, {
        privateSetId, variantName: "Base", cardNumber, player,
      });
    return { requestId, privateSetId, add };
  }

  test("a requested set takes private cards the collector can own", async () => {
    const s = await setup();
    const { privateSetId, add } = await askSet(s);
    const { privateCardId } = await add("11T", "Barry Bonds");
    await s.me.mutation(api.collection.addHave, { cardId: privateCardId });
    expect(await s.me.query(api.collectionRequests.mySets, {})).toEqual([
      expect.objectContaining({ _id: privateSetId, year: "1986", brand: "Topps", name: "Topps Traded" }),
    ]);
    const cards = await s.me.query(api.collectionRequests.privateSetCards, { privateSetId });
    expect(cards).toEqual([expect.objectContaining({ cardNumber: "11T", variantName: "Base", set: null })]);
    expect(await s.them.query(api.collectionRequests.privateSetCards, { privateSetId })).toEqual([]);
    await expect(
      s.them.mutation(api.collectionRequests.addPrivateCard, {
        privateSetId, variantName: "Base", cardNumber: "1", player: "x",
      }),
    ).rejects.toThrow(/isn't one you asked for/);
  });

  test("approval moves only exactly-one-number matches; the rest are the collector's to file", async () => {
    const s = await setup();
    const { requestId, privateSetId, add } = await askSet(s);
    const bonds = await add("11T", "Barry Bonds");
    const canseco = await add("20T", "Jose Canseco");
    await s.me.mutation(api.collection.addHave, { cardId: bonds.privateCardId });
    await s.me.mutation(api.collection.addHave, { cardId: canseco.privateCardId });
    // The admin builds the set: Base with 11T and 20T, and a Tiffany parallel with 20T again.
    const built = await s.t.run(async (ctx) => {
      const base = await ctx.db.insert("selectorOptions", {
        level: "variantType", value: "Base", parentId: s.fx.set86Id, platformData: {}, children: [], lastUpdated: 1,
      } as never);
      const parType = await ctx.db.insert("selectorOptions", {
        level: "variantType", value: "Parallels", parentId: s.fx.set86Id, platformData: {}, children: [], lastUpdated: 1,
      } as never);
      const tiffany = await ctx.db.insert("selectorOptions", {
        level: "insert", value: "Tiffany", parentId: parType, platformData: {}, children: [], lastUpdated: 1,
      } as never);
      const b11 = await insertTestCard(ctx, { selectorOptionId: base as Id<"selectorOptions">, cardNumber: "11T", cardName: "Barry Bonds", platformData: {}, sortOrder: 9, lastUpdated: 1 });
      const b20 = await insertTestCard(ctx, { selectorOptionId: base as Id<"selectorOptions">, cardNumber: "20T", cardName: "Jose Canseco", platformData: {}, sortOrder: 9, lastUpdated: 1 });
      await insertTestCard(ctx, { selectorOptionId: tiffany as Id<"selectorOptions">, cardNumber: "20T", cardName: "Jose Canseco", platformData: {}, sortOrder: 9, lastUpdated: 1 });
      return { b11, b20 };
    });
    expect(
      await s.admin.mutation(api.collectionRequests.approveSet, { requestId, setId: s.fx.set86Id }),
    ).toEqual({ matched: 1, left: 1 });
    const rows = await copies(s);
    expect(rows.map((r) => r.cardId).sort()).toEqual([built.b11, canseco.privateCardId].sort());
    const [mine] = await s.me.query(api.collectionRequests.mine, {});
    expect(mine).toMatchObject({ status: "added", addedSetId: s.fx.set86Id, privateSetId, cards: 1 });
    // A requested set that is NB's now takes no more private cards.
    await expect(add("30T", "Wally Joyner")).rejects.toThrow(/in the catalog now/);
    // The collector files the ambiguous one themselves, from the two 20Ts.
    const candidates = await s.me.query(api.collectionRequests.fileCandidates, { privateCardId: canseco.privateCardId });
    expect(candidates.map((c) => c.cardNumber)).toEqual(["20T", "20T"]);
    expect(candidates.map((c) => c._id)).toContain(built.b20);
    expect(await s.them.query(api.collectionRequests.fileCandidates, { privateCardId: canseco.privateCardId })).toEqual([]);
    await expect(
      s.me.mutation(api.collectionRequests.fileAs, { privateCardId: canseco.privateCardId, cardId: s.fx.gooden1 }),
    ).rejects.toThrow(/Pick a card from that set/);
    await expect(
      s.them.mutation(api.collectionRequests.fileAs, { privateCardId: canseco.privateCardId, cardId: built.b20 }),
    ).rejects.toThrow(/isn't one of yours/);
    expect(
      await s.me.mutation(api.collectionRequests.fileAs, { privateCardId: canseco.privateCardId, cardId: built.b20 }),
    ).toEqual({ moved: 1 });
    expect((await copies(s)).map((r) => r.cardId).sort()).toEqual([built.b11, built.b20].sort());
    expect(await s.t.run((ctx) => ctx.db.get(privateSetId))).toBeNull();
    const [after] = await s.me.query(api.collectionRequests.mine, {});
    expect(after.privateSetId).toBeUndefined();
    expect(await tallyOf(s)).toMatchObject({ copies: 2, lines: 2, distinctCards: 2 });
  });

  test("withdrawing a set deletes every private card in it and their copies", async () => {
    const s = await setup();
    const { requestId, privateSetId, add } = await askSet(s);
    const a = await add("1T", "A");
    await add("2T", "B");
    await s.me.mutation(api.collection.addHave, { cardId: a.privateCardId });
    expect(await s.me.mutation(api.collectionRequests.withdraw, { requestId })).toEqual({ copies: 1, cards: 2 });
    expect(await s.t.run((ctx) => ctx.db.get(privateSetId))).toBeNull();
    expect(await s.t.run((ctx) => ctx.db.query("privateCards").collect())).toEqual([]);
    expect(await copies(s)).toEqual([]);
  });
});

describe("review", () => {
  test("lists the queue oldest first and flags NB cards that already carry the number", async () => {
    const s = await setup();
    const first = await askBase(s, { cardNumber: "1", player: "Doc Gooden", variantId: undefined, variantName: "Atomic" });
    await askBase(s, {}, s.them);
    const queue = await s.admin.query(api.collectionRequests.queue, {});
    expect(queue.map((q) => q.ownerId)).toEqual([ME.subject, THEM.subject]);
    expect(await s.admin.query(api.collectionRequests.waitingCount, {})).toBe(2);
    const review = await s.admin.query(api.collectionRequests.review, { requestId: first.requestId });
    expect(review?.sameNumber.map((c) => c._id).sort()).toEqual(
      [s.fx.gooden1, s.fx.gooden1Sliding, s.fx.gold1].sort(),
    );
    expect(review?.privateCard).toMatchObject({ cardNumber: "1", variantName: "Atomic" });
    await s.admin.mutation(api.collectionRequests.decline, { requestId: first.requestId });
    expect(await s.admin.query(api.collectionRequests.waitingCount, {})).toBe(1);
    expect(await s.admin.query(api.collectionRequests.queue, { status: "declined" })).toHaveLength(1);
  });
});
