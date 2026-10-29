/**
 * NEO-360 — public share links: `convex/publicCollection.ts` (the anonymous
 * reads) and the owner's switches (`collectionContainers.ensureLink`,
 * `setSlug`, `setVisibility`, `publicProfile.setShelfVisibility`).
 *
 * The forbidden-key scan is the one that matters most: seed a copy with every
 * private field set, call every public query, and walk the JSON for any
 * forbidden key or any of those values.
 */

import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import { seedCollectionCatalog } from "../lib/testing/collection-fixture";
import type { Id } from "./_generated/dataModel";
import { MAX_PUBLIC_PAGE } from "./publicCollection";

const modules = (import.meta as unknown as {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
}).glob("./**/*.*s");

const ME = { subject: "collector_me_001" };
const THEM = { subject: "collector_them_002" };
const PAGE = { numItems: 20, cursor: null };

async function setup() {
  const t = convexTest(schema, modules);
  const fx = await seedCollectionCatalog(t);
  const me = t.withIdentity(ME);
  const them = t.withIdentity(THEM);
  await me.mutation(api.publicProfile.upsertPublicProfile, { username: "ace" });
  await them.mutation(api.publicProfile.upsertPublicProfile, { username: "deuce" });
  const system = await me.mutation(api.collectionContainers.ensureSystem, {});
  return { t, fx, me, them, anon: t, system };
}
type S = Awaited<ReturnType<typeof setup>>;

async function binder(s: S, name = "Ohtani rainbow", who: "me" | "them" = "me") {
  const caller = who === "me" ? s.me : s.them;
  const { containerId } = await caller.mutation(api.collectionContainers.create, { kind: "binder", name });
  const row = await s.t.run(async (ctx) => ctx.db.get(containerId));
  return { id: containerId, path: row!.slug!, row: row! };
}

const PRIVATE_VALUES = {
  costCents: 123_456,
  acquiredOn: "2019-04-01",
  location: "Closet shelf B",
  notes: "Paid too much, do not tell anyone",
  cert: "CERT-99887766",
  serialNumber: "07/99",
};
const FORBIDDEN_KEYS = [
  "costCents",
  "acquiredOn",
  "location",
  "notes",
  "cert",
  "serialNumber",
  "homeId",
  "ownerId",
  "userId",
  "lastUpdated",
  "binderId",
];

/**
 * Walk everything for the private VALUES; walk the keys outside the card's
 * catalog data (a team's `location` is NB's "New York", not the copy's shelf).
 */
function scan(value: unknown, path: string, hits: string[], forbiddenValues: string[], inCard = false) {
  if (value === null || value === undefined) return;
  if (typeof value === "string" || typeof value === "number") {
    if (forbiddenValues.includes(String(value))) hits.push(`${path} = ${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scan(item, `${path}[${i}]`, hits, forbiddenValues, inCard));
    return;
  }
  if (typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      if (!inCard && FORBIDDEN_KEYS.includes(key)) hits.push(`${path}.${key}`);
      scan(inner, `${path}.${key}`, hits, forbiddenValues, inCard || key === "card");
    }
  }
}

describe("the forbidden-key scan", () => {
  test("no public query carries a private field, its value, a copy id or the owner's subject", async () => {
    const s = await setup();
    const b = await binder(s);
    const { containerId: box } = await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Show box" });
    const details = {
      quantity: 1,
      condition: "Near Mint" as const,
      grading: { grader: "PSA" as const, grade: "10", cert: PRIVATE_VALUES.cert },
      serialNumber: PRIVATE_VALUES.serialNumber,
      costCents: PRIVATE_VALUES.costCents,
      acquiredOn: PRIVATE_VALUES.acquiredOn,
      location: PRIVATE_VALUES.location,
      notes: PRIVATE_VALUES.notes,
      upForTrade: true,
    };
    const inBinder = await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.gooden1,
      details: { ...details, homeId: b.id, slot: 4 },
    });
    const inBox = await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.strawberry2,
      details: { ...details, homeId: box },
    });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, binderId: b.id, on: true });
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" });
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: s.system.wantId, visibility: "public" });

    const answers = {
      binder: await s.anon.query(api.publicCollection.binder, { username: "ace", path: b.path }),
      binderCopies: await s.anon.query(api.publicCollection.binderCopies, { username: "ace", path: b.path, paginationOpts: PAGE }),
      wantList: await s.anon.query(api.publicCollection.wantList, { username: "ace", paginationOpts: PAGE }),
      trade: await s.anon.query(api.publicCollection.trade, { username: "ace", paginationOpts: PAGE }),
      forSale: await s.anon.query(api.publicCollection.forSale, { username: "ace", paginationOpts: PAGE }),
      shelves: await s.anon.query(api.publicCollection.shelves, { username: "ace" }),
      shelfWant: await s.anon.query(api.publicCollection.shelf, { username: "ace", shelf: "want" }),
      shelfTrade: await s.anon.query(api.publicCollection.shelf, { username: "ace", shelf: "trade" }),
      shelfSale: await s.anon.query(api.publicCollection.shelf, { username: "ace", shelf: "forSale" }),
      profile: await s.anon.query(api.publicProfile.getPublicProfileByUsername, { username: "ace" }),
    };
    // Something to scan: each list really answered.
    expect(answers.binderCopies.page).toHaveLength(1);
    expect(answers.wantList.page).toHaveLength(1);
    expect(answers.trade.page).toHaveLength(2);
    expect(answers.forSale.page).toHaveLength(1);
    expect(answers.binderCopies.page[0]).toMatchObject({
      condition: "Near Mint",
      grading: { grader: "PSA", grade: "10" },
      slot: 4,
      upForTrade: true,
    });

    const hits: string[] = [];
    const forbiddenValues = [
      ...Object.values(PRIVATE_VALUES).map(String),
      ME.subject,
      inBinder.copyId,
      inBox.copyId,
      b.id,
      box,
    ];
    scan(answers, "answers", hits, forbiddenValues);
    expect(hits).toEqual([]);
  });
});

describe("NEO-367 catalog card notes", () => {
  test("a public binder carries the catalog card's Notes, never the copy's", async () => {
    const s = await setup();
    const b = await binder(s);
    await s.t.run(async (ctx) => ctx.db.patch(s.fx.gooden1, { notes: "Short print, about 1:120 packs" }));
    await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.gooden1,
      details: { quantity: 1, homeId: b.id, slot: 1, notes: PRIVATE_VALUES.notes },
    });
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" });
    const { page } = await s.anon.query(api.publicCollection.binderCopies, { username: "ace", path: b.path, paginationOpts: PAGE });
    expect(page).toHaveLength(1);
    expect(page[0].card?.notes).toBe("Short print, about 1:120 packs");
    expect(page[0]).not.toHaveProperty("notes");
    expect(JSON.stringify(page)).not.toContain(PRIVATE_VALUES.notes);
  });
});

describe("defaults", () => {
  test("a new binder and the Want List read as not found until switched public", async () => {
    const s = await setup();
    const b = await binder(s);
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 1, homeId: b.id } });
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, on: true });
    expect(await s.anon.query(api.publicCollection.binder, { username: "ace", path: b.path })).toBeNull();
    expect((await s.anon.query(api.publicCollection.binderCopies, { username: "ace", path: b.path, paginationOpts: PAGE })).page).toEqual([]);
    expect(await s.anon.query(api.publicCollection.shelf, { username: "ace", shelf: "want" })).toBeNull();
    expect((await s.anon.query(api.publicCollection.wantList, { username: "ace", paginationOpts: PAGE })).page).toEqual([]);

    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" });
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: s.system.wantId, visibility: "public" });
    expect(await s.anon.query(api.publicCollection.binder, { username: "ace", path: b.path })).toMatchObject({
      name: "Ohtani rainbow",
      count: { copies: 1, lines: 1 },
    });
    expect((await s.anon.query(api.publicCollection.wantList, { username: "ace", paginationOpts: PAGE })).page).toHaveLength(1);

    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "private" });
    expect(await s.anon.query(api.publicCollection.binder, { username: "ace", path: b.path })).toBeNull();
  });

  test("Up for Trade and for-sale read as public until switched private", async () => {
    const s = await setup();
    const { copyId } = await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 1 } });
    await s.me.mutation(api.collection.setTrade, { copyId, on: true });
    const { containerId: box } = await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Show box" });
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.strawberry2, details: { quantity: 2, homeId: box } });

    expect((await s.anon.query(api.publicCollection.trade, { username: "ace", paginationOpts: PAGE })).page).toHaveLength(1);
    expect((await s.anon.query(api.publicCollection.forSale, { username: "ace", paginationOpts: PAGE })).page).toHaveLength(1);
    expect(await s.anon.query(api.publicCollection.shelves, { username: "ace" })).toEqual({
      binders: [],
      wantList: false,
      trade: true,
      forSale: true,
    });

    await s.me.mutation(api.publicProfile.setShelfVisibility, { shelf: "trade", private: true });
    await s.me.mutation(api.publicProfile.setShelfVisibility, { shelf: "forSale", private: true });
    expect(await s.anon.query(api.publicCollection.shelf, { username: "ace", shelf: "trade" })).toBeNull();
    expect((await s.anon.query(api.publicCollection.trade, { username: "ace", paginationOpts: PAGE })).page).toEqual([]);
    expect((await s.anon.query(api.publicCollection.forSale, { username: "ace", paginationOpts: PAGE })).page).toEqual([]);
    expect(await s.anon.query(api.publicCollection.shelves, { username: "ace" })).toEqual({
      binders: [],
      wantList: false,
      trade: false,
      forSale: false,
    });

    await s.me.mutation(api.publicProfile.setShelfVisibility, { shelf: "trade", private: false });
    expect((await s.anon.query(api.publicCollection.trade, { username: "ace", paginationOpts: PAGE })).page).toHaveLength(1);
  });

  test("the shelf switches never reach the public profile", async () => {
    const s = await setup();
    await s.me.mutation(api.publicProfile.setShelfVisibility, { shelf: "trade", private: true });
    const profile = await s.anon.query(api.publicProfile.getPublicProfileByUsername, { username: "ace" });
    expect(profile).not.toBeNull();
    expect(Object.keys(profile!)).not.toContain("tradePrivate");
    const mine = await s.me.query(api.publicProfile.getMyPublicProfile, {});
    expect(mine?.tradePrivate).toBe(true);
  });
});

describe("Main, boxes and the system shelves", () => {
  test("Main can't be made public, and a hand-written public Main still reads as not found", async () => {
    const s = await setup();
    const main = s.system.mainId;
    await expect(
      s.me.mutation(api.collectionContainers.setVisibility, { containerId: main, visibility: "public" }),
    ).rejects.toThrow(/Main is never shared/);
    await expect(s.me.mutation(api.collectionContainers.setSlug, { containerId: main, slug: "main-stuff" })).rejects.toThrow(
      /Main is never shared/,
    );
    await expect(s.me.mutation(api.collectionContainers.ensureLink, { containerId: main })).rejects.toThrow();
    await s.t.run(async (ctx) => ctx.db.patch(main, { slug: "main", visibility: "public" }));
    expect(await s.anon.query(api.publicCollection.binder, { username: "ace", path: "main" })).toBeNull();
  });

  test("a box and Up for Trade take no visibility, and a hand-written public box reads as not found", async () => {
    const s = await setup();
    const { containerId: box } = await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Show box" });
    const row = await s.t.run(async (ctx) => ctx.db.get(box));
    expect(row?.slug).toBeUndefined();
    await expect(
      s.me.mutation(api.collectionContainers.setVisibility, { containerId: box, visibility: "public" }),
    ).rejects.toThrow(/box/);
    await expect(
      s.me.mutation(api.collectionContainers.setVisibility, { containerId: s.system.tradeId, visibility: "public" }),
    ).rejects.toThrow();
    await s.t.run(async (ctx) => ctx.db.patch(box, { slug: "show-box", visibility: "public" }));
    expect(await s.anon.query(api.publicCollection.binder, { username: "ace", path: "show-box" })).toBeNull();
    expect((await s.anon.query(api.publicCollection.shelves, { username: "ace" }))?.binders).toEqual([]);
  });
});

describe("guessing", () => {
  test("a wrong link name, private, missing, unknown user and garbage all read the same null", async () => {
    const s = await setup();
    const pub = await binder(s, "Ohtani rainbow");
    const priv = await binder(s, "Secret stash");
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: pub.id, visibility: "public" });
    const probes = [
      { username: "ace", path: "ohtani-rainbows" },
      { username: "ace", path: priv.path },
      { username: "ace", path: "nothing-here" },
      { username: "nobody", path: pub.path },
      { username: "ace", path: "Ohtani-Rainbow" },
      { username: "ACE", path: pub.path },
      { username: "ace", path: "x".repeat(500) },
    ];
    for (const probe of probes) {
      expect(await s.anon.query(api.publicCollection.binder, probe)).toBeNull();
    }
    expect(await s.anon.query(api.publicCollection.binder, { username: "ace", path: pub.path })).not.toBeNull();
  });

  test("another collector's binder under my username reads as not found", async () => {
    const s = await setup();
    const theirs = await binder(s, "Their binder", "them");
    await s.them.mutation(api.collectionContainers.setVisibility, { containerId: theirs.id, visibility: "public" });
    expect(await s.anon.query(api.publicCollection.binder, { username: "deuce", path: theirs.path })).not.toBeNull();
    expect(await s.anon.query(api.publicCollection.binder, { username: "ace", path: theirs.path })).toBeNull();
  });
});

describe("counts and paging", () => {
  test("an absent stored count reads as null, never a recount", async () => {
    const s = await setup();
    const b = await binder(s);
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 1, homeId: b.id } });
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" });
    await s.t.run(async (ctx) => ctx.db.patch(b.id, { count: undefined }));
    const header = await s.anon.query(api.publicCollection.binder, { username: "ace", path: b.path });
    expect(header?.count).toBeNull();
    const row = await s.t.run(async (ctx) => ctx.db.get(b.id));
    expect(row?.count).toBeUndefined();
  });

  test(`a page holds at most ${MAX_PUBLIC_PAGE} lines whatever the client asks`, async () => {
    const s = await setup();
    const b = await binder(s);
    const cardIds = await s.t.run(async (ctx) => {
      const ids: Id<"cardChecklist">[] = [];
      const base = await ctx.db.get(s.fx.gooden1);
      for (let i = 0; i < MAX_PUBLIC_PAGE + 5; i++) {
        const { _id: _ignored, _creationTime: _c, ...rest } = base!;
        ids.push(await ctx.db.insert("cardChecklist", { ...rest, cardNumber: `P${i}`, sortOrder: 1000 + i }));
      }
      return ids;
    });
    for (const cardId of cardIds) {
      await s.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, homeId: b.id } });
    }
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" });
    const first = await s.anon.query(api.publicCollection.binderCopies, {
      username: "ace",
      path: b.path,
      paginationOpts: { numItems: 10_000, cursor: null },
    });
    expect(first.page).toHaveLength(MAX_PUBLIC_PAGE);
    expect(first.isDone).toBe(false);
    const rest = await s.anon.query(api.publicCollection.binderCopies, {
      username: "ace",
      path: b.path,
      paginationOpts: { numItems: 10_000, cursor: first.continueCursor },
    });
    expect(rest.page).toHaveLength(5);
  });

  test("for-sale walks box by box to the end", async () => {
    const s = await setup();
    const { containerId: a } = await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "A" });
    const { containerId: b } = await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "B" });
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 1, homeId: a } });
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.strawberry2, details: { quantity: 1, homeId: b } });
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const page: { page: unknown[]; isDone: boolean; continueCursor: string } = await s.anon.query(
        api.publicCollection.forSale,
        { username: "ace", paginationOpts: { numItems: 5, cursor } },
      );
      seen.push(page.page.length);
      // The cursor names a box by its place, never its id.
      expect(page.continueCursor).not.toContain(a);
      expect(page.continueCursor).not.toContain(b);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    expect(seen.reduce((x, y) => x + y, 0)).toBe(2);
    // A forged place past the last box reads as the end.
    const forged = await s.anon.query(api.publicCollection.forSale, {
      username: "ace",
      paginationOpts: { numItems: 5, cursor: "7|" },
    });
    expect(forged.page).toEqual([]);
  });
});

describe("what the shelves say", () => {
  test("the Want List carries cards only; Up for Trade marks box copies for sale without naming the box", async () => {
    const s = await setup();
    const b = await binder(s);
    await s.me.mutation(api.collectionWants.set, { cardId: s.fx.gooden1, binderId: b.id, on: true });
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: s.system.wantId, visibility: "public" });
    const wants = await s.anon.query(api.publicCollection.wantList, { username: "ace", paginationOpts: PAGE });
    expect(Object.keys(wants.page[0]).sort()).toEqual(["card", "key"]);

    const { containerId: box } = await s.me.mutation(api.collectionContainers.create, { kind: "box", name: "Secret box name" });
    await s.me.mutation(api.collection.addLineItem, {
      cardId: s.fx.strawberry2,
      details: { quantity: 1, homeId: box, upForTrade: true },
    });
    const trade = await s.anon.query(api.publicCollection.trade, { username: "ace", paginationOpts: PAGE });
    expect(trade.page[0].forSale).toBe(true);
    expect(JSON.stringify(trade)).not.toContain("Secret box name");

    // For-sale switched private: Up for Trade stops saying which cards are for sale.
    await s.me.mutation(api.publicProfile.setShelfVisibility, { shelf: "forSale", private: true });
    const hidden = await s.anon.query(api.publicCollection.trade, { username: "ace", paginationOpts: PAGE });
    expect(hidden.page[0].forSale).toBeUndefined();
  });
});

describe("unlisted cards (NEO-361)", () => {
  test("a collector's own card shows as unlisted: number, player and set, never its notes, photos or request", async () => {
    const s = await setup();
    const b = await binder(s);
    const photo = await s.t.run(async (ctx) => ctx.storage.store(new Blob(["front"], { type: "image/jpeg" })));
    const { privateCardId } = await s.me.mutation(api.collectionRequests.requestCard, {
      setId: s.fx.setId,
      variantName: "Gold Foil",
      cardNumber: "77",
      player: "Rookie Nobody",
      notes: PRIVATE_VALUES.notes,
    });
    await s.t.run(async (ctx) => ctx.db.patch(privateCardId, { frontImageId: photo }));
    await s.me.mutation(api.collection.addLineItem, {
      cardId: privateCardId,
      details: { quantity: 2, homeId: b.id, slot: 0, condition: "Mint" },
    });
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" });
    const { page } = await s.anon.query(api.publicCollection.binderCopies, { username: "ace", path: b.path, paginationOpts: PAGE });
    expect(page).toHaveLength(1);
    expect(page[0].card).toBeUndefined();
    expect(page[0]).toMatchObject({
      quantity: 2,
      condition: "Mint",
      unlisted: { cardNumber: "77", player: "Rookie Nobody", variantName: "Gold Foil", variant: null, requestedSet: null },
    });
    expect(page[0].unlisted?.set?._id).toBe(s.fx.setId);
    const json = JSON.stringify(page);
    for (const leak of [privateCardId, photo, PRIVATE_VALUES.notes, "requestId", "Url"]) expect(json).not.toContain(leak);
  });
});

describe("links", () => {
  test("a new binder is born with a plain link name; a rename keeps it; a twin name gets -2", async () => {
    const s = await setup();
    const b = await binder(s, "Ohtani Rainbow!");
    expect(b.row.slug).toBe("ohtani-rainbow");
    const twin = await binder(s, "Ohtani rainbow");
    expect(twin.row.slug).toBe("ohtani-rainbow-2");
    const theirs = await binder(s, "Ohtani rainbow", "them");
    expect(theirs.row.slug).toBe("ohtani-rainbow");
    await s.me.mutation(api.collectionContainers.update, { containerId: b.id, name: "Shohei" });
    const after = await s.t.run(async (ctx) => ctx.db.get(b.id));
    expect(after?.slug).toBe(b.row.slug);
  });

  test("setSlug checks the format, refuses a name another binder uses, and kills the old link", async () => {
    const s = await setup();
    const b = await binder(s);
    const other = await binder(s, "Gold stuff");
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" });
    for (const bad of ["ab", "has--double", "-edge", "émoji✨", "a".repeat(51), "UPPER/slash"]) {
      await expect(s.me.mutation(api.collectionContainers.setSlug, { containerId: b.id, slug: bad })).rejects.toThrow(
        /lowercase letters/,
      );
    }
    await expect(
      s.me.mutation(api.collectionContainers.setSlug, { containerId: b.id, slug: other.path }),
    ).rejects.toThrow(/already uses/);
    // Its own name is never "taken".
    await s.me.mutation(api.collectionContainers.setSlug, { containerId: b.id, slug: "ohtani-rainbow" });
    const { link, previous } = await s.me.mutation(api.collectionContainers.setSlug, {
      containerId: b.id,
      slug: "  Shohei Gold ",
    });
    expect(link.slug).toBe("shohei-gold");
    expect(previous).toBe("ohtani-rainbow");
    expect(await s.anon.query(api.publicCollection.binder, { username: "ace", path: b.path })).toBeNull();
    expect(await s.anon.query(api.publicCollection.binder, { username: "ace", path: "shohei-gold" })).not.toBeNull();
  });

  test("the profile's shelf lists public binders only, by name", async () => {
    const s = await setup();
    const zed = await binder(s, "Zed binder");
    const ace = await binder(s, "Ace binder");
    await binder(s, "Private stash");
    for (const b of [zed, ace]) {
      await s.me.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" });
    }
    const shelves = await s.anon.query(api.publicCollection.shelves, { username: "ace" });
    expect(shelves?.binders).toEqual([
      { name: "Ace binder", slug: "ace-binder", count: { copies: 0, lines: 0 } },
      { name: "Zed binder", slug: "zed-binder", count: { copies: 0, lines: 0 } },
    ]);
  });

  test("ensureLink mints a link for a binder made before NEO-360, once", async () => {
    const s = await setup();
    const old = await s.t.run(async (ctx) =>
      ctx.db.insert("collectionContainers", {
        ownerId: ME.subject,
        kind: "binder",
        name: "'96 Contenders",
        count: { copies: 0, lines: 0 },
        lastUpdated: 0,
      }),
    );
    const a = await s.me.mutation(api.collectionContainers.ensureLink, { containerId: old });
    const b = await s.me.mutation(api.collectionContainers.ensureLink, { containerId: old });
    expect(a.slug).toBe("96-contenders");
    expect(b).toEqual(a);
  });
});

describe("the switches are the owner's", () => {
  test("setVisibility, setSlug, ensureLink and setShelfVisibility refuse signed-out callers and other collectors' rows", async () => {
    const s = await setup();
    const b = await binder(s);
    const anonCalls = [
      () => s.anon.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" }),
      () => s.anon.mutation(api.collectionContainers.setSlug, { containerId: b.id, slug: "mine-now" }),
      () => s.anon.mutation(api.collectionContainers.ensureLink, { containerId: b.id }),
      () => s.anon.mutation(api.publicProfile.setShelfVisibility, { shelf: "trade", private: true }),
    ];
    for (const call of anonCalls) await expect(call()).rejects.toThrow(/Not authenticated/);
    const theirCalls = [
      () => s.them.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" }),
      () => s.them.mutation(api.collectionContainers.setSlug, { containerId: b.id, slug: "mine-now" }),
      () => s.them.mutation(api.collectionContainers.ensureLink, { containerId: b.id }),
    ];
    for (const call of theirCalls) await expect(call()).rejects.toThrow(/isn't in your collection/);
    const row = await s.t.run(async (ctx) => ctx.db.get(b.id));
    expect(row).toMatchObject({ slug: b.row.slug });
    expect(row?.visibility).toBeUndefined();
  });

  test("setShelfVisibility needs a public name first", async () => {
    const s = await setup();
    const fresh = s.t.withIdentity({ subject: "no_profile_yet" });
    await expect(fresh.mutation(api.publicProfile.setShelfVisibility, { shelf: "trade", private: true })).rejects.toThrow(
      /public name/,
    );
  });
});

describe("NEO-362: a binder's layout and shared empty slots", () => {
  test("a visitor gets the sort, and the empty slots only once the owner shares them", async () => {
    const s = await setup();
    const b = await binder(s, "Chrome");
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" });
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 1, homeId: b.id } });
    const read = () => s.anon.query(api.publicCollection.binder, { username: "ace", path: b.path });
    const needs = () => s.anon.query(api.publicCollection.binderNeeds, { username: "ace", path: b.path });

    expect((await read())?.layout).toBeUndefined();
    await s.me.mutation(api.collectionContainers.setSettings, { containerId: b.id, sort: "checklist", emptySlots: true });
    expect((await read())?.layout).toEqual({ sort: "checklist", emptySlots: false, smart: false });
    expect((await needs()).needs).toEqual([]);

    await s.me.mutation(api.collectionContainers.setSettings, { containerId: b.id, publicEmptySlots: true });
    expect((await read())?.layout).toEqual({ sort: "checklist", emptySlots: true, smart: false });
    const shared = await needs();
    expect(shared.needs.map((n) => n.card._id)).toEqual([s.fx.strawberry2]);
    // A visitor never learns whether the owner has the card somewhere else.
    expect(shared.needs.every((n) => n.held === false)).toBe(true);
  });

  test("a private binder's empty slots stay private", async () => {
    const s = await setup();
    const b = await binder(s, "Private");
    await s.me.mutation(api.collectionContainers.setSettings, {
      containerId: b.id,
      sort: "checklist",
      emptySlots: true,
      publicEmptySlots: true,
    });
    await s.me.mutation(api.collection.addLineItem, { cardId: s.fx.gooden1, details: { quantity: 1, homeId: b.id } });
    expect((await s.anon.query(api.publicCollection.binderNeeds, { username: "ace", path: b.path })).needs).toEqual([]);
  });
});

describe("NEO-377 copy photos on public pages", () => {
  test("a public copy carries its live photos; a pending one and a copy with none carry nothing", async () => {
    vi.stubEnv("CONVEX_SITE_URL", "https://example.convex.site");
    const s = await setup();
    const b = await binder(s);
    const add = async (cardId: typeof s.fx.gooden1, slot: number) =>
      (await s.me.mutation(api.collection.addLineItem, { cardId, details: { quantity: 1, homeId: b.id, slot } })).copyId;
    const shot = await add(s.fx.gooden1, 1);
    const plain = await add(s.fx.strawberry2, 2);
    const reserve = (copyId: typeof shot, side: "front" | "back") =>
      s.t.mutation(internal.copyPhotos.reserveUpload, {
        ownerId: ME.subject,
        copyId,
        side,
        contentType: "image/jpeg",
        imageBytes: 10,
        thumbBytes: 10,
      });
    const { photoId } = await reserve(shot, "front");
    await s.t.mutation(internal.copyPhotos.commitUpload, { ownerId: ME.subject, photoId });
    await reserve(shot, "back"); // never finished: stays pending
    await reserve(plain, "front");
    await s.me.mutation(api.collectionContainers.setVisibility, { containerId: b.id, visibility: "public" });

    const { page } = await s.anon.query(api.publicCollection.binderCopies, { username: "ace", path: b.path, paginationOpts: PAGE });
    const bySlot = new Map(page.map((row) => [row.slot, row]));
    expect(bySlot.get(1)?.photos?.front?.thumbUrl).toMatch(/^https:\/\/example\.convex\.site\/copy-photo\/[0-9a-f]{32}\/thumb$/);
    expect(bySlot.get(1)?.photos?.back).toBeUndefined();
    expect(bySlot.get(2)).not.toHaveProperty("photos");
    vi.unstubAllEnvs();
  });
});
