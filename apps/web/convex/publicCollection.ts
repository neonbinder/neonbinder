/**
 * NEO-360 — public share links: every anonymous read of a collection.
 *
 * PUBLIC BY INTENT. The anonymous caller is someone opening a link a collector
 * posted (a binder, the Want List, Up for Trade, the for-sale stock) who will
 * never sign in: a trade partner on a forum, a buyer from a group chat. Every
 * other collection module stays caller-scoped (`requireSignedIn`); nothing
 * here loosens them, and nothing here writes.
 *
 * ## What a visitor can reach
 *
 *   - A binder the collector made AND switched public, by its link name
 *     (`/u/<username>/binders/<slug>`). Binders start private; a private
 *     binder's link reads as not found.
 *   - The Want List, once switched public. It starts private.
 *   - Up for Trade and the for-sale stock (every copy whose home is a box)
 *     unless the collector switched them private. They start public.
 *   - The profile's shelf (`shelves`): the PUBLIC binders' names and links,
 *     and which public shelves have anything on them. Never a private one.
 *   - Never Main, a single box or a set.
 *
 * ## The steps every handler takes
 *
 *  1. Check `username` (and a binder's `path`) against their shapes before any
 *     read. A bad value reads as not found.
 *  2. Resolve the username to its owner inside the handler. The owner's Clerk
 *     subject never leaves it; no returned field carries `ownerId`.
 *  3. Answer the SAME not-found (null, or an empty page) for a missing user, a
 *     private page, a wrong link name, Main, a box and a system row, so
 *     probing a link cannot tell a private binder from a missing one.
 *  4. Read with the owner's indexes only, at most `MAX_PUBLIC_PAGE` lines a
 *     page whatever the client asks.
 *  5. Map every copy through `publicCopyOut`, built field by field from an
 *     allowlist (`publicCopyValidator`). Never a spread row.
 *
 * NEO-361: a copy of the collector's own card (one NB doesn't have) shows
 * as `unlisted` (its number, player and where it belongs), never its notes,
 * photos or request.
 *
 * Never public: cost, acquired date, location, notes, grading cert, serial
 * number, a copy's home or its id, a box's name, any other binder's link, and
 * timestamps, a private binder's name or link. Counts are the stored ones only (null when absent): a visitor
 * can never trigger a recount.
 */

import { v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { query } from "./_generated/server";
import { MAX_CONTAINERS } from "./collection";
import { photoUrlsOf } from "./copyPhotos";
import { binderNeeds as readBinderNeeds, needsResultValidator } from "./binderRules";
import {
  collectionCopyConditionValidator,
  collectionCopyGradingValidator,
  collectionCountValidator,
  collectionLabelValidator,
} from "./schema";
import {
  CatalogReader,
  catalogCardWithPathValidator,
  pathNodeValidator,
  setRefValidator,
  variantRefValidator,
} from "./lib/catalogView";
import { USERNAME_RE, isSlug } from "../lib/collection/share-links";

type ContainerRow = Doc<"collectionContainers">;
type CopyRow = Doc<"collectionCopies">;
type Count = typeof collectionCountValidator.type;

/** Lines one public page returns at most. */
export const MAX_PUBLIC_PAGE = 60;

const EMPTY_PAGE = { page: [], isDone: true, continueCursor: "" };

// ───────────────────────────────────────────────────────────────────────────
// Validators: what may leave
// ───────────────────────────────────────────────────────────────────────────

/** A grade without its cert number: the cert pins down one exact slab. */
const publicGradingValidator = v.object({
  grader: collectionCopyGradingValidator.fields.grader,
  grade: v.string(),
});

/**
 * NEO-361 — a collector's own card (one NB doesn't have) as a visitor sees
 * it: what is printed on it and where it belongs. Never its notes, photos or
 * request, nor any id.
 */
export const publicUnlistedCardValidator = v.object({
  cardNumber: v.string(),
  player: v.string(),
  /** The checklist as the collector typed it, when it is not one of the set's. */
  variantName: v.optional(v.string()),
  set: v.union(setRefValidator, v.null()),
  variant: v.union(variantRefValidator, v.null()),
  /** The set the collector asked us to add, when it is not an NB set. */
  requestedSet: v.union(
    v.object({ sport: v.union(pathNodeValidator, v.null()), year: v.string(), brand: v.string(), name: v.string() }),
    v.null(),
  ),
});

/** One line item as a visitor sees it. An allowlist, not a trimmed `copyValidator`. */
export const publicCopyValidator = v.object({
  /** Opaque and stable per line, for list keys. Not the copy's id. */
  key: v.string(),
  quantity: v.number(),
  condition: v.optional(collectionCopyConditionValidator),
  grading: v.optional(publicGradingValidator),
  /** Binder pages only: `page * 9 + pocket`. */
  slot: v.optional(v.number()),
  /** On the collector's Up for Trade shelf. */
  upForTrade: v.optional(v.literal(true)),
  /** Up for Trade only: this copy also sits in a box, so it's for sale too. */
  forSale: v.optional(v.literal(true)),
  /** The NB card. Exactly one of `card` and `unlisted` is present. */
  card: v.optional(catalogCardWithPathValidator),
  /** NEO-361 — the collector's own card, one NB doesn't have (Jason: shown, marked). */
  unlisted: v.optional(publicUnlistedCardValidator),
  /**
   * NEO-377 — photos of this very copy, when the collector took them. Public
   * like the copy itself (they will go on marketplace listings too).
   */
  photos: v.optional(
    v.object({
      front: v.optional(v.object({ imageUrl: v.string(), thumbUrl: v.string() })),
      back: v.optional(v.object({ imageUrl: v.string(), thumbUrl: v.string() })),
    }),
  ),
});

/** A wanted card as a visitor sees it: the card only, never the binder it's for. */
export const publicWantValidator = v.object({
  key: v.string(),
  card: catalogCardWithPathValidator,
});

export const publicBinderValidator = v.object({
  name: v.string(),
  description: v.optional(v.string()),
  label: v.optional(collectionLabelValidator),
  /** The stored count; null when it was never counted. */
  count: v.union(collectionCountValidator, v.null()),
  /**
   * NEO-362 — how the owner lays it out: a sort (drawn on read, so the page
   * draws it too) and whether visitors see its empty slots (only when the
   * owner switched that on). Absent: pockets as stored.
   */
  layout: v.optional(
    v.object({
      sort: v.optional(v.union(v.literal("checklist"), v.literal("player"), v.literal("team"))),
      emptySlots: v.boolean(),
      smart: v.boolean(),
    }),
  ),
});

const shelfValidator = v.union(v.literal("want"), v.literal("trade"), v.literal("forSale"));

// ───────────────────────────────────────────────────────────────────────────
// Access checks
// ───────────────────────────────────────────────────────────────────────────

/** The profile a username names, or null for a bad or unknown one. */
async function profileOf(ctx: QueryCtx, username: string): Promise<Doc<"publicProfiles"> | null> {
  if (!USERNAME_RE.test(username)) return null;
  return await ctx.db
    .query("publicProfiles")
    .withIndex("by_username", (q) => q.eq("username", username))
    .first();
}

/**
 * The binder a public path names, or null: unknown user, malformed or
 * unknown link name, private, or not a binder the collector made (Main, a box, a system shelf, even one with `visibility` written on
 * it by hand). Every one of those is the same null.
 */
async function publicBinder(
  ctx: QueryCtx,
  username: string,
  path: string,
): Promise<{ ownerId: string; row: ContainerRow } | null> {
  if (!isSlug(path)) return null;
  const profile = await profileOf(ctx, username);
  if (!profile) return null;
  const ownerId = profile.userId;
  const row = await ctx.db
    .query("collectionContainers")
    .withIndex("by_owner_and_slug", (q) => q.eq("ownerId", ownerId).eq("slug", path))
    .first();
  if (!row || row.ownerId !== ownerId) return null;
  if (row.system !== undefined || row.kind !== "binder") return null;
  if (row.visibility !== "public") return null;
  return { ownerId, row };
}

async function systemRow(
  ctx: QueryCtx,
  ownerId: string,
  system: "want" | "trade",
): Promise<ContainerRow | null> {
  return await ctx.db
    .query("collectionContainers")
    .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId).eq("system", system))
    .first();
}

/** The collector's boxes, oldest first: the for-sale stock's homes. */
async function boxesOf(ctx: QueryCtx, ownerId: string): Promise<ContainerRow[]> {
  const own = await ctx.db
    .query("collectionContainers")
    .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId).eq("system", undefined))
    .take(MAX_CONTAINERS);
  return own.filter((row) => row.kind === "box");
}

/**
 * The owner of a public shelf, or null when the user is unknown or the shelf
 * is private: the Want List until switched public, Up for Trade and for-sale
 * once switched private.
 */
async function shelfOwner(
  ctx: QueryCtx,
  username: string,
  shelf: typeof shelfValidator.type,
): Promise<string | null> {
  const profile = await profileOf(ctx, username);
  if (!profile) return null;
  if (shelf === "trade") return profile.tradePrivate ? null : profile.userId;
  if (shelf === "forSale") return profile.forSalePrivate ? null : profile.userId;
  const want = await systemRow(ctx, profile.userId, "want");
  return want?.visibility === "public" ? profile.userId : null;
}

// ───────────────────────────────────────────────────────────────────────────
// Mapping
// ───────────────────────────────────────────────────────────────────────────

/** A short, stable, one-way key for a row, so the page never hands out its id. */
function opaqueKey(id: string): string {
  // Two FNV-1a passes with different offsets: 64 bits, plenty to stay unique
  // on one page, and nothing a visitor can feed back into another function.
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < id.length; i++) {
    const c = id.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (b >>> 15);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

type PublicCopy = typeof publicCopyValidator.type;

/**
 * NEO-361 — the card a copy is of, as a visitor sees it: the NB card, or the
 * collector's own card (`unlisted`). Null when it is gone, or (never in
 * practice) a private card that isn't the copy owner's.
 */
async function publicCardOf(
  reader: CatalogReader,
  ctx: QueryCtx,
  row: CopyRow,
): Promise<Pick<PublicCopy, "card" | "unlisted"> | null> {
  const ownId = ctx.db.normalizeId("privateCards", row.cardId);
  if (ownId) {
    const own = await ctx.db.get(ownId);
    if (!own || own.ownerId !== row.ownerId) return null;
    const requested = own.privateSetId ? await ctx.db.get(own.privateSetId) : null;
    const sport = requested ? await reader.row(requested.sportId) : null;
    return {
      unlisted: {
        cardNumber: own.cardNumber,
        player: own.player,
        ...(own.variantName ? { variantName: own.variantName } : {}),
        set: own.setId ? await reader.setRef(own.setId) : null,
        variant: own.variantId ? await reader.variantRef(own.variantId) : null,
        requestedSet: requested
          ? {
              sport: sport ? { _id: sport._id, name: sport.value } : null,
              year: requested.year,
              brand: requested.brand,
              name: requested.name,
            }
          : null,
      },
    };
  }
  const cardId = ctx.db.normalizeId("cardChecklist", row.cardId);
  const card = cardId ? await ctx.db.get(cardId) : null;
  return card ? { card: await reader.cardWithPath(card) } : null;
}

/**
 * One copy as a visitor sees it, or null when its card left the catalog.
 * Built field by field; add a field here only after deciding it is public.
 */
async function publicCopyOut(
  reader: CatalogReader,
  ctx: QueryCtx,
  row: CopyRow,
  extra: { slot?: boolean; forSale?: boolean },
): Promise<PublicCopy | null> {
  const shown = await publicCardOf(reader, ctx, row);
  if (!shown) return null;
  const photos = await photoUrlsOf(ctx, row);
  return {
    key: opaqueKey(row._id),
    quantity: row.quantity,
    ...(row.condition ? { condition: row.condition } : {}),
    ...(row.grading ? { grading: { grader: row.grading.grader, grade: row.grading.grade } } : {}),
    ...(extra.slot && row.slot !== undefined ? { slot: row.slot } : {}),
    ...(row.upForTrade === true ? { upForTrade: true as const } : {}),
    ...(extra.forSale ? { forSale: true as const } : {}),
    ...(photos.front || photos.back ? { photos } : {}),
    ...shown,
  };
}

async function mapCopies(
  ctx: QueryCtx,
  rows: CopyRow[],
  extra: (row: CopyRow) => Promise<{ slot?: boolean; forSale?: boolean }>,
): Promise<PublicCopy[]> {
  const reader = new CatalogReader(ctx);
  const out: PublicCopy[] = [];
  for (const row of rows) {
    const copy = await publicCopyOut(reader, ctx, row, await extra(row));
    if (copy) out.push(copy);
  }
  return out;
}

function capped<T extends { numItems: number }>(opts: T): T {
  const n = Math.floor(opts.numItems);
  return { ...opts, numItems: Math.max(1, Math.min(Number.isFinite(n) ? n : 1, MAX_PUBLIC_PAGE)) };
}

function sumCounts(counts: Array<Count | undefined>): Count | null {
  let copies = 0;
  let lines = 0;
  for (const count of counts) {
    if (!count) return null;
    copies += count.copies;
    lines += count.lines;
  }
  return { copies, lines };
}

// ───────────────────────────────────────────────────────────────────────────
// Queries
// ───────────────────────────────────────────────────────────────────────────

/** A public binder's header, or null (see `publicBinder` for every reason). */
export const binder = query({
  args: { username: v.string(), path: v.string() },
  returns: v.union(publicBinderValidator, v.null()),
  handler: async (ctx, args) => {
    const found = await publicBinder(ctx, args.username, args.path);
    if (!found) return null;
    const { row } = found;
    const layout = publicLayout(row);
    return {
      name: row.name,
      ...(row.description ? { description: row.description } : {}),
      ...(row.label ? { label: row.label } : {}),
      count: row.count ?? null,
      ...(layout ? { layout } : {}),
    };
  },
});

/** NEO-362 — what a visitor's page draws: the sort, and empty slots only when the owner shares them. */
function publicLayout(row: ContainerRow) {
  const sort = row.settings?.sort;
  const emptySlots =
    row.settings?.publicEmptySlots === true && row.settings?.emptySlots !== false && (!!sort || !!row.rule);
  if (!sort && !emptySlots) return null;
  return { ...(sort ? { sort } : {}), emptySlots, smart: !!row.rule };
}

/**
 * NEO-362 — a public binder's empty slots (`binderRules.binderNeeds`), only
 * when its owner shares them (`publicLayout`); otherwise none. Never says
 * whether the owner holds a card elsewhere.
 */
export const binderNeeds = query({
  args: { username: v.string(), path: v.string() },
  returns: needsResultValidator,
  handler: async (ctx, args) => {
    const found = await publicBinder(ctx, args.username, args.path);
    if (!found || !publicLayout(found.row)?.emptySlots) return { needs: [], supported: true, truncated: false };
    return await readBinderNeeds(ctx, found.row, null);
  },
});

/** A public binder's copies in pocket order (unplaced first), a page at a time. */
export const binderCopies = query({
  args: { username: v.string(), path: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(publicCopyValidator),
  handler: async (ctx, args) => {
    const found = await publicBinder(ctx, args.username, args.path);
    if (!found) return EMPTY_PAGE;
    const { ownerId, row } = found;
    const result = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", row._id))
      .paginate(capped(args.paginationOpts));
    return { ...result, page: await mapCopies(ctx, result.page, async () => ({ slot: true })) };
  },
});

/**
 * Whether a shelf is public, and its stored count: null when it is private
 * or the user is unknown. `count` is null when never counted.
 */
export const shelf = query({
  args: { username: v.string(), shelf: shelfValidator },
  returns: v.union(v.object({ count: v.union(collectionCountValidator, v.null()) }), v.null()),
  handler: async (ctx, args) => {
    const ownerId = await shelfOwner(ctx, args.username, args.shelf);
    if (!ownerId) return null;
    if (args.shelf === "forSale") {
      const boxes = await boxesOf(ctx, ownerId);
      return { count: sumCounts(boxes.map((box) => box.count)) };
    }
    const row = await systemRow(ctx, ownerId, args.shelf);
    return { count: row?.count ?? null };
  },
});

const publicBinderLinkValidator = v.object({
  name: v.string(),
  slug: v.string(),
  count: v.union(collectionCountValidator, v.null()),
});

/**
 * The public profile's shelf: the collector's PUBLIC binders (name, link
 * name, stored count), by name, and each public shelf that is not known to
 * be empty. A private binder is never listed. Null for an unknown user.
 */
export const shelves = query({
  args: { username: v.string() },
  returns: v.union(
    v.object({
      binders: v.array(publicBinderLinkValidator),
      wantList: v.boolean(),
      trade: v.boolean(),
      forSale: v.boolean(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const profile = await profileOf(ctx, args.username);
    if (!profile) return null;
    const ownerId = profile.userId;
    const hasAny = (count: Count | null | undefined) => count === null || count === undefined || count.lines > 0;
    const own = await ctx.db
      .query("collectionContainers")
      .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId).eq("system", undefined))
      .take(MAX_CONTAINERS);
    const binders = own
      .filter((row) => row.kind === "binder" && row.visibility === "public" && row.slug)
      .map((row) => ({ name: row.name, slug: row.slug!, count: row.count ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const want = await systemRow(ctx, ownerId, "want");
    const trade = profile.tradePrivate ? null : await systemRow(ctx, ownerId, "trade");
    const boxes = profile.forSalePrivate ? [] : own.filter((row) => row.kind === "box");
    return {
      binders,
      wantList: want?.visibility === "public" && hasAny(want.count),
      trade: !!trade && hasAny(trade.count),
      forSale: boxes.length > 0 && hasAny(sumCounts(boxes.map((box) => box.count))),
    };
  },
});

/** A public Want List's cards, a page at a time. Never says which binder a want is for. */
export const wantList = query({
  args: { username: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(publicWantValidator),
  handler: async (ctx, args) => {
    const ownerId = await shelfOwner(ctx, args.username, "want");
    if (!ownerId) return EMPTY_PAGE;
    const result = await ctx.db
      .query("collectionWants")
      .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId))
      .paginate(capped(args.paginationOpts));
    const reader = new CatalogReader(ctx);
    const page: Array<typeof publicWantValidator.type> = [];
    for (const want of result.page) {
      const card = await ctx.db.get(want.cardId);
      if (card) page.push({ key: opaqueKey(want._id), card: await reader.cardWithPath(card) });
    }
    return { ...result, page };
  },
});

/**
 * Up for Trade's copies, a page at a time. A copy whose home is a box is
 * marked `forSale`, unless the collector switched for-sale private (then the
 * flag would leak what that switch hides); the box itself is never named.
 */
export const trade = query({
  args: { username: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(publicCopyValidator),
  handler: async (ctx, args) => {
    const ownerId = await shelfOwner(ctx, args.username, "trade");
    if (!ownerId) return EMPTY_PAGE;
    const forSalePublic = !(await profileOf(ctx, args.username))?.forSalePrivate;
    const result = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_trade", (q) => q.eq("ownerId", ownerId).eq("upForTrade", true))
      .paginate(capped(args.paginationOpts));
    const homes = new Map<string, ContainerRow | null>();
    const page = await mapCopies(ctx, result.page, async (row) => {
      const key = row.homeId as string;
      if (!homes.has(key)) homes.set(key, await ctx.db.get(row.homeId));
      const home = homes.get(key);
      return { forSale: forSalePublic && !!home && home.ownerId === ownerId && !home.system && home.kind === "box" };
    });
    return { ...result, page };
  },
});

/**
 * The for-sale stock: every copy whose home is one of the collector's boxes,
 * box by box (oldest box first, in row order), a page at a time, at most
 * `MAX_CONTAINERS` boxes. One page never spans two boxes, so a cursor is the
 * box's place in that order and a cursor inside it: `<index>|<inner cursor>`
 * (never the box's id: a visitor learns nothing about which box). A place past
 * the last box reads as the end.
 */
export const forSale = query({
  args: { username: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(publicCopyValidator),
  handler: async (ctx, args) => {
    const ownerId = await shelfOwner(ctx, args.username, "forSale");
    if (!ownerId) return EMPTY_PAGE;
    const boxes = await boxesOf(ctx, ownerId);
    if (boxes.length === 0) return EMPTY_PAGE;
    const parse = (cursor: string | null | undefined) => {
      if (!cursor) return null;
      const at = cursor.indexOf("|");
      if (at < 0) return undefined;
      const place = cursor.slice(0, at);
      if (!/^\d{1,4}$/.test(place)) return undefined;
      const index = Number(place);
      if (index >= boxes.length) return undefined;
      const inner = cursor.slice(at + 1);
      return { index, inner: inner === "" ? null : inner };
    };
    const start = parse(args.paginationOpts.cursor);
    if (start === undefined) return EMPTY_PAGE;
    const index = start?.index ?? 0;
    const box = boxes[index];
    const end = parse(args.paginationOpts.endCursor);
    const innerEnd = end && end.index === index ? end.inner : undefined;
    const result = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", box._id as Id<"collectionContainers">))
      .paginate({
        numItems: capped(args.paginationOpts).numItems,
        cursor: start?.inner ?? null,
        ...(innerEnd !== undefined && innerEnd !== null ? { endCursor: innerEnd } : {}),
      });
    const page = await mapCopies(ctx, result.page, async () => ({}));
    const next = boxes[index + 1];
    if (result.isDone && next && innerEnd === undefined) {
      return { page, isDone: false, continueCursor: `${index + 1}|` };
    }
    return { page, isDone: result.isDone && !next, continueCursor: `${index}|${result.continueCursor}` };
  },
});
