/**
 * NEO-361 — "Can't find it? Ask us to add it."
 *
 * Two requests (Jason, 2026-10-26):
 *   - **Request a Card**, for a set NB has. The collector picks the NB set
 *     (and the checklist, or types its name when it isn't listed) and types
 *     the card number and player; notes and front/back photos are optional.
 *     The request makes a PRIVATE card at once (`privateCards`), so they can
 *     file copies of it the same day.
 *   - **Request a Set**, for a set NB lacks. The collector picks the sport
 *     and types the year, brand and set name as printed. It makes a private
 *     set they file private cards into (`addPrivateCard`).
 *
 * Anything waiting or declined stays privately ownable: a private card is
 * the caller's alone, never catalog data, never in a checklist or a count.
 *
 * An admin decides (`requireAdmin`):
 *   - `approveCard`: the request becomes one NB card (an existing one, or one
 *     the admin just added with the set builder's quick add). The
 *     collector's copies move onto it (`moveOntoCatalogCard`) and the private
 *     card goes.
 *   - `approveSet`: the set request becomes one NB set (built in the set
 *     builder). Each private card whose number names exactly one card in
 *     that set moves onto it; the rest stay private for the collector to
 *     file (`fileAs`), because a number is never unique in a set (product
 *     invariant 7) and nothing here guesses.
 *   - `decline`: it stays the collector's, with an optional note.
 *
 * `withdraw` deletes a waiting or declined request and everything it made,
 * copies included (Jason: "when withdrawn delete all copies of the card").
 *
 * Every collector read and write is owner-scoped: another collector's
 * request, private card or private set reads exactly like one that does not
 * exist. NB data only: nothing here reads or writes a marketplace field.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireAdmin, requireSignedIn } from "./auth";
import {
  COLLECTION_ERRORS,
  MAX_LINES_PER_CARD,
  MAX_COPY_QUANTITY,
  type CountChange,
  applyCopyChanges,
  changeOf,
  cleanText,
  counted,
  detailsOf,
  foldsInto,
  placeOf,
  refuse,
} from "./collection";
import { MAX_SET_VARIANTS, walkSetVariants } from "./collectionCatalog";
import { findSetForSelectorOption } from "./lib/selectorAncestry";
import {
  CatalogReader,
  catalogCardWithPathValidator,
  pathNodeValidator,
  setRefValidator,
  variantRefValidator,
} from "./lib/catalogView";
import { cardRequestKindValidator, cardRequestStatusValidator } from "./schema";

type RequestRow = Doc<"cardRequests">;
type PrivateCardRow = Doc<"privateCards">;
type PrivateSetRow = Doc<"privateSets">;

/** Requests one collector may hold that are not added yet. */
export const MAX_OPEN_REQUESTS = 200;
/** Private cards one collector may hold, over every request. */
export const MAX_PRIVATE_CARDS = 2000;
/** Private cards one requested set may hold. */
export const MAX_PRIVATE_SET_CARDS = 500;
/** Copy lines one withdraw may delete (a bigger one asks to remove some first). */
export const MAX_WITHDRAW_LINES = 2000;
/** Copy lines one set approval may move; the rest stay private to `fileAs`. */
export const MAX_APPROVE_SET_LINES = 2000;
/** Index reads one set approval may spend matching numbers. */
export const MAX_APPROVE_SET_LOOKUPS = 2000;
/** Requests one page of `mine` or the admin queue lists. */
export const MAX_REQUEST_LIST = 200;
/** Same-number cards the review shows for one request. */
export const MAX_SAME_NUMBER = 20;
/** A photo's largest size. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** Photo upload URLs one collector may take in an hour. */
export const MAX_PHOTO_UPLOADS_PER_HOUR = 40;
/** How long an upload may sit attached to no card before the sweep deletes it. */
export const PHOTO_UPLOAD_TTL_MS = 60 * 60 * 1000;
/** Files and tickets one sweep run looks at. */
const PHOTO_SWEEP_BATCH = 200;
/**
 * The photo types a request takes: what phones and cameras write. Never SVG
 * (it can carry script, and admins open the raw URL) and never untyped.
 */
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"] as const;

const MAX_SET_NAME = 120;
const MAX_BRAND = 80;
const MAX_YEAR = 12;
const MAX_CARD_NUMBER = 20;
const MAX_PLAYER = 120;
const MAX_VARIANT_NAME = 120;
const MAX_NOTES = 2000;
const MAX_SEARCHED = 200;
const MAX_DECISION_NOTE = 500;

const CARD_BEARING = new Set(["variantType", "insert", "parallel"]);

// ───────────────────────────────────────────────────────────────────────────
// Validators
// ───────────────────────────────────────────────────────────────────────────

/** A requested set, as its owner (or an admin) reads it. */
export const privateSetValidator = v.object({
  _id: v.id("privateSets"),
  requestId: v.id("cardRequests"),
  status: cardRequestStatusValidator,
  sport: v.union(pathNodeValidator, v.null()),
  year: v.string(),
  brand: v.string(),
  name: v.string(),
});

/**
 * A private card, hydrated like a catalog card's path: the NB set and
 * checklist it belongs in when the collector picked them, or the requested
 * set. `status` is its request's: waiting or declined (an added card is a
 * catalog card, so no private card is left).
 */
export const privateCardValidator = v.object({
  _id: v.id("privateCards"),
  requestId: v.id("cardRequests"),
  status: cardRequestStatusValidator,
  cardNumber: v.string(),
  player: v.string(),
  variantName: v.optional(v.string()),
  notes: v.optional(v.string()),
  set: v.union(setRefValidator, v.null()),
  variant: v.union(variantRefValidator, v.null()),
  privateSet: v.union(privateSetValidator, v.null()),
  frontImageUrl: v.optional(v.string()),
  backImageUrl: v.optional(v.string()),
});

/** One request in the collector's list. */
export const myRequestValidator = v.object({
  _id: v.id("cardRequests"),
  kind: cardRequestKindValidator,
  status: cardRequestStatusValidator,
  label: v.string(),
  notes: v.optional(v.string()),
  decisionNote: v.optional(v.string()),
  decidedAt: v.optional(v.number()),
  requestedAt: v.number(),
  privateCardId: v.optional(v.id("privateCards")),
  privateSetId: v.optional(v.id("privateSets")),
  addedCardId: v.optional(v.id("cardChecklist")),
  addedSetId: v.optional(v.id("selectorOptions")),
  /** Physical copies a withdraw would delete (every private card it made). */
  copies: v.number(),
  /** Private cards it made: one for a card request, the set's for a set request. */
  cards: v.number(),
});

/** One request in the admin queue. */
export const queueItemValidator = v.object({
  _id: v.id("cardRequests"),
  kind: cardRequestKindValidator,
  status: cardRequestStatusValidator,
  label: v.string(),
  ownerId: v.string(),
  requestedAt: v.number(),
  hasPhotos: v.boolean(),
});

const photoArgs = {
  frontImageId: v.optional(v.id("_storage")),
  backImageId: v.optional(v.id("_storage")),
};

// ───────────────────────────────────────────────────────────────────────────
// Rules and shared pieces
// ───────────────────────────────────────────────────────────────────────────

/** Required text: trimmed, non-blank, capped. */
function needText(raw: string, max: number, what: string): string {
  const out = cleanText(raw, max, what);
  if (!out) refuse(COLLECTION_ERRORS.invalid, `Add the ${what}.`);
  return out;
}

/** A card number as typed, without a leading "#" ("#41" and "41" are one). */
function cleanNumber(raw: string): string {
  return needText(raw.replace(/^\s*#/, ""), MAX_CARD_NUMBER, "card number");
}

/** The card (if any) a stored photo is already on. */
async function photoInUse(ctx: Pick<QueryCtx, "db">, id: Id<"_storage">): Promise<boolean> {
  const front = await ctx.db
    .query("privateCards")
    .withIndex("by_front_image", (q) => q.eq("frontImageId", id))
    .first();
  if (front) return true;
  const back = await ctx.db
    .query("privateCards")
    .withIndex("by_back_image", (q) => q.eq("backImageId", id))
    .first();
  return back !== null;
}

/**
 * A photo the collector uploaded: there, a photo type, not too big, and on
 * no other card. (A refused upload is left for the sweep: a refusal rolls the
 * whole mutation back, a delete included.)
 */
async function checkPhoto(
  ctx: MutationCtx,
  id: Id<"_storage"> | undefined,
): Promise<Id<"_storage"> | undefined> {
  if (id === undefined) return undefined;
  const meta = await ctx.db.system.get(id);
  if (!meta) refuse(COLLECTION_ERRORS.invalid, "That photo didn't finish uploading. Try adding it again.");
  if (!meta.contentType || !(PHOTO_TYPES as readonly string[]).includes(meta.contentType)) {
    refuse(COLLECTION_ERRORS.invalid, "That file isn't a photo. Add a JPG, PNG, WebP or HEIC.");
  }
  if (meta.size > MAX_PHOTO_BYTES) {
    refuse(COLLECTION_ERRORS.invalid, "That photo is over 10 MB. Add a smaller one.");
  }
  if (await photoInUse(ctx, id)) {
    refuse(COLLECTION_ERRORS.invalid, "That photo is already on a card. Add it again.");
  }
  return id;
}

/** The caller's own request, or a not-found refusal. */
async function ownRequest(
  ctx: MutationCtx,
  ownerId: string,
  requestId: Id<"cardRequests">,
): Promise<RequestRow> {
  const row = await ctx.db.get(requestId);
  if (!row || row.ownerId !== ownerId) {
    refuse(COLLECTION_ERRORS.notFound, "That request isn't one of yours.");
  }
  return row;
}

/** Any request, for an admin, or a not-found refusal. */
async function anyRequest(ctx: MutationCtx, requestId: Id<"cardRequests">): Promise<RequestRow> {
  const row = await ctx.db.get(requestId);
  if (!row) refuse(COLLECTION_ERRORS.notFound, "That request isn't there anymore.");
  return row;
}

/** "1996-97 Score", the way a collector names a set. */
function setLabel(set: { season: string; name: string }): string {
  return [set.season, set.name].filter(Boolean).join(" ");
}

/** "1986 Topps Traded": the brand once, even when the set's name already starts with it. */
function privateSetLabel(set: Pick<PrivateSetRow, "year" | "brand" | "name">): string {
  const named = set.name.toLowerCase().startsWith(set.brand.toLowerCase()) ? set.name : `${set.brand} ${set.name}`;
  return [set.year, named].filter(Boolean).join(" ");
}

/** The caller's open requests and private cards are capped; refuse past either. */
async function checkCaps(ctx: MutationCtx, ownerId: string, newRequest: boolean): Promise<void> {
  if (newRequest) {
    const open = await ctx.db
      .query("cardRequests")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .take(MAX_OPEN_REQUESTS * 4);
    if (open.filter((r) => r.status !== "added").length >= MAX_OPEN_REQUESTS) {
      refuse(COLLECTION_ERRORS.limit, `You have ${MAX_OPEN_REQUESTS} requests open. Withdraw some first.`);
    }
  }
  const cards = await ctx.db
    .query("privateCards")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .take(MAX_PRIVATE_CARDS);
  if (cards.length >= MAX_PRIVATE_CARDS) {
    refuse(COLLECTION_ERRORS.limit, `You have ${MAX_PRIVATE_CARDS} cards of your own already. Remove some first.`);
  }
}

/** The owner's lines of one card (catalog or private), at most `MAX_LINES_PER_CARD`. */
async function linesOf(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  cardId: Id<"cardChecklist"> | Id<"privateCards">,
): Promise<Array<Doc<"collectionCopies">>> {
  return await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", cardId))
    .take(MAX_LINES_PER_CARD + 1);
}

/** Delete a private card's photos from storage. A missing one is fine. */
async function deletePhotos(ctx: MutationCtx, card: PrivateCardRow): Promise<void> {
  for (const id of [card.frontImageId, card.backImageId]) {
    if (!id) continue;
    if (await ctx.db.system.get(id)) await ctx.storage.delete(id);
  }
}

/**
 * Drop a private card row and its photos, once its copies are gone or moved.
 * (Not a catalog card: those only ever go through `removeCardRow`.)
 */
async function discardPrivateCard(ctx: MutationCtx, row: PrivateCardRow): Promise<void> {
  await deletePhotos(ctx, row);
  await ctx.db.delete(row._id);
}

/**
 * Move every copy of the owner's private card onto the NB card `cardId`, in
 * place: each line keeps its home, pocket, trade flag and details, and folds
 * into an identical line of the NB card when one is there (the one fold
 * rule, `foldsInto`). The tally, container counts and set builds move in
 * the same transaction. Does not delete the private card. Returns the lines
 * moved.
 */
export async function moveOntoCatalogCard(
  ctx: MutationCtx,
  ownerId: string,
  privateCardId: Id<"privateCards">,
  cardId: Id<"cardChecklist">,
): Promise<number> {
  const place = await placeOf(ctx, cardId);
  const rows = await linesOf(ctx, ownerId, privateCardId);
  if (rows.length === 0) return 0;
  const target = await linesOf(ctx, ownerId, cardId);
  const changes: CountChange[] = [];
  const now = Date.now();
  for (const row of rows) {
    const mine = detailsOf(row);
    const twin = target.find(
      (t) => foldsInto(detailsOf(t), mine) && t.quantity + row.quantity <= MAX_COPY_QUANTITY,
    );
    if (twin) {
      const quantity = twin.quantity + row.quantity;
      await ctx.db.patch(twin._id, { quantity, lastUpdated: now });
      changes.push(changeOf(twin, counted(twin), counted({ ...twin, quantity })));
      twin.quantity = quantity;
      await ctx.db.delete(row._id);
      changes.push(changeOf(row, counted(row), null));
      continue;
    }
    if (target.length >= MAX_LINES_PER_CARD) {
      refuse(
        COLLECTION_ERRORS.limit,
        `They already have ${MAX_LINES_PER_CARD} lines of that card, so these can't join it. They need to stack some first.`,
      );
    }
    await ctx.db.patch(row._id, {
      cardId,
      variantId: place.variantId,
      setId: place.setId,
      lastUpdated: now,
    });
    // The line leaves the private card and joins the NB one, in place.
    changes.push(changeOf(row, counted(row), null));
    changes.push(changeOf({ cardId, setId: place.setId }, null, counted(row)));
    target.push({ ...row, cardId, variantId: place.variantId, setId: place.setId });
  }
  await applyCopyChanges(ctx, ownerId, changes);
  return rows.length;
}

/**
 * Delete a private card and every copy of it, moving the tally and counts.
 * The caller checks the total first (`MAX_WITHDRAW_LINES`).
 */
async function deletePrivateCard(ctx: MutationCtx, card: PrivateCardRow): Promise<void> {
  const rows = await linesOf(ctx, card.ownerId, card._id);
  for (const row of rows) await ctx.db.delete(row._id);
  if (rows.length > 0) {
    await applyCopyChanges(
      ctx,
      card.ownerId,
      rows.map((row) => changeOf(row, counted(row), null)),
    );
  }
  await discardPrivateCard(ctx, card);
}

/** The private cards a request made: its one card, or its set's. */
async function cardsOfRequest(
  ctx: Pick<QueryCtx, "db">,
  request: RequestRow,
): Promise<PrivateCardRow[]> {
  if (request.privateCardId) {
    const card = await ctx.db.get(request.privateCardId);
    return card ? [card] : [];
  }
  if (request.privateSetId) {
    const setId = request.privateSetId;
    return await ctx.db
      .query("privateCards")
      .withIndex("by_private_set", (q) => q.eq("privateSetId", setId))
      .take(MAX_PRIVATE_SET_CARDS);
  }
  return [];
}

/** Physical copies (and lines) of `cards`, counting at most `MAX_WITHDRAW_LINES + 1` lines. */
async function copiesOfCards(
  ctx: Pick<QueryCtx, "db">,
  cards: ReadonlyArray<PrivateCardRow>,
): Promise<{ copies: number; lines: number }> {
  let copies = 0;
  let lines = 0;
  for (const card of cards) {
    if (lines > MAX_WITHDRAW_LINES) break;
    for (const row of await linesOf(ctx, card.ownerId, card._id)) {
      copies += row.quantity;
      lines += 1;
    }
  }
  return { copies, lines };
}

/**
 * The NB cards in `setId` carrying `cardNumber`, at most `MAX_SAME_NUMBER`,
 * the checklist `first` (when given) ahead of the set's others. A list to
 * pick from, never a match on its own (invariant 7).
 */
async function sameNumberIn(
  ctx: Pick<QueryCtx, "db">,
  reader: CatalogReader,
  setId: Id<"selectorOptions">,
  cardNumber: string,
  first?: Id<"selectorOptions">,
): Promise<Array<typeof catalogCardWithPathValidator.type>> {
  const variants: Array<Id<"selectorOptions">> = first ? [first] : [];
  await walkSetVariants(ctx, setId, async (variant) => {
    if (variants.length >= MAX_SET_VARIANTS) return false;
    if (variant._id !== first) variants.push(variant._id);
    return true;
  });
  const out = [];
  for (const variantId of variants) {
    if (out.length >= MAX_SAME_NUMBER) break;
    const hits = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option_and_number", (q) =>
        q.eq("selectorOptionId", variantId).eq("cardNumber", cardNumber),
      )
      .take(MAX_SAME_NUMBER - out.length);
    for (const hit of hits) out.push(await reader.cardWithPath(hit));
  }
  return out;
}

/** A private set as its readers see it. */
async function privateSetOut(
  ctx: Pick<QueryCtx, "db">,
  reader: CatalogReader,
  row: PrivateSetRow,
): Promise<typeof privateSetValidator.type> {
  const request = await ctx.db.get(row.requestId);
  const sport = await reader.row(row.sportId);
  return {
    _id: row._id,
    requestId: row.requestId,
    status: request?.status ?? "declined",
    sport: sport ? { _id: sport._id, name: sport.value } : null,
    year: row.year,
    brand: row.brand,
    name: row.name,
  };
}

/** A private card, hydrated (see `privateCardValidator`). */
async function privateCardOut(
  ctx: Pick<QueryCtx, "db" | "storage">,
  reader: CatalogReader,
  row: PrivateCardRow,
): Promise<typeof privateCardValidator.type> {
  const request = await ctx.db.get(row.requestId);
  const privateSet = row.privateSetId ? await ctx.db.get(row.privateSetId) : null;
  const front = row.frontImageId ? await ctx.storage.getUrl(row.frontImageId) : null;
  const back = row.backImageId ? await ctx.storage.getUrl(row.backImageId) : null;
  return {
    _id: row._id,
    requestId: row.requestId,
    status: request?.status ?? "declined",
    cardNumber: row.cardNumber,
    player: row.player,
    ...(row.variantName ? { variantName: row.variantName } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    set: row.setId ? await reader.setRef(row.setId) : null,
    variant: row.variantId ? await reader.variantRef(row.variantId) : null,
    privateSet: privateSet ? await privateSetOut(ctx, reader, privateSet) : null,
    ...(front ? { frontImageUrl: front } : {}),
    ...(back ? { backImageUrl: back } : {}),
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Collector: send, add to a requested set, withdraw
// ───────────────────────────────────────────────────────────────────────────

/** Where to upload one photo for a request (Convex file storage). */
export const generateUploadUrl = mutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const now = Date.now();
    const recent = await ctx.db
      .query("photoUploadTickets")
      .withIndex("by_owner_and_created", (q) => q.eq("ownerId", ownerId).gt("createdAt", now - PHOTO_UPLOAD_TTL_MS))
      .take(MAX_PHOTO_UPLOADS_PER_HOUR);
    if (recent.length >= MAX_PHOTO_UPLOADS_PER_HOUR) {
      refuse(COLLECTION_ERRORS.limit, "That's a lot of photos for one hour. Try again a little later.");
    }
    await ctx.db.insert("photoUploadTickets", { ownerId, createdAt: now });
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * "Request a Card": a card in a set NB has. `setId` is the NB set;
 * `variantId` the checklist when it is listed, else `variantName` is its
 * name as typed. Makes the request and the caller's private card at once.
 */
export const requestCard = mutation({
  args: {
    setId: v.id("selectorOptions"),
    variantId: v.optional(v.id("selectorOptions")),
    variantName: v.optional(v.string()),
    cardNumber: v.string(),
    player: v.string(),
    notes: v.optional(v.string()),
    searched: v.optional(v.string()),
    ...photoArgs,
  },
  returns: v.object({ requestId: v.id("cardRequests"), privateCardId: v.id("privateCards") }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const set = await ctx.db.get(args.setId);
    if (!set || set.level !== "setName") {
      refuse(COLLECTION_ERRORS.notFound, "That set isn't in the catalog. Use Request a Set instead.");
    }
    let variantId: Id<"selectorOptions"> | undefined;
    if (args.variantId) {
      const row = await ctx.db.get(args.variantId);
      if (
        !row ||
        !CARD_BEARING.has(row.level) ||
        (await findSetForSelectorOption(ctx, args.variantId)) !== args.setId
      ) {
        refuse(COLLECTION_ERRORS.invalid, "That checklist isn't in this set. Pick one from the list.");
      }
      variantId = args.variantId;
    }
    const variantName = cleanText(args.variantName, MAX_VARIANT_NAME, "checklist name");
    if (!variantId && !variantName) {
      refuse(COLLECTION_ERRORS.invalid, "Pick the checklist, or type its name if it isn't listed.");
    }
    const cardNumber = cleanNumber(args.cardNumber);
    const player = needText(args.player, MAX_PLAYER, "player");
    const notes = cleanText(args.notes, MAX_NOTES, "note");
    const searched = cleanText(args.searched, MAX_SEARCHED, "search");
    const frontImageId = await checkPhoto(ctx, args.frontImageId);
    const backImageId = await checkPhoto(ctx, args.backImageId);
    await checkCaps(ctx, ownerId, true);

    const reader = new CatalogReader(ctx);
    const ref = await reader.setRef(args.setId);
    const variantRef = variantId ? await reader.variantRef(variantId) : null;
    const checklist = variantName ?? (variantRef && variantRef.kind !== "base" ? variantRef.name : "");
    const label = [ref ? setLabel(ref) : set.value, checklist, `#${cardNumber}`, player]
      .filter(Boolean)
      .join(" ");
    const now = Date.now();
    const requestId = await ctx.db.insert("cardRequests", {
      ownerId,
      kind: "card",
      status: "waiting",
      ...(searched ? { searched } : {}),
      ...(notes ? { notes } : {}),
      label,
      lastUpdated: now,
    });
    const privateCardId = await ctx.db.insert("privateCards", {
      ownerId,
      requestId,
      setId: args.setId,
      ...(variantId ? { variantId } : {}),
      ...(variantName ? { variantName } : {}),
      cardNumber,
      player,
      ...(notes ? { notes } : {}),
      ...(frontImageId ? { frontImageId } : {}),
      ...(backImageId ? { backImageId } : {}),
      lastUpdated: now,
    });
    await ctx.db.patch(requestId, { privateCardId });
    return { requestId, privateCardId };
  },
});

/**
 * "Request a Set": a set NB lacks. The NB sport, then the year, brand and
 * set name as printed. Makes the request and the caller's private set.
 */
export const requestSet = mutation({
  args: {
    sportId: v.id("selectorOptions"),
    year: v.string(),
    brand: v.string(),
    name: v.string(),
    notes: v.optional(v.string()),
    searched: v.optional(v.string()),
  },
  returns: v.object({ requestId: v.id("cardRequests"), privateSetId: v.id("privateSets") }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const sport = await ctx.db.get(args.sportId);
    if (!sport || sport.level !== "sport") {
      refuse(COLLECTION_ERRORS.invalid, "Pick the sport from the list.");
    }
    const year = needText(args.year, MAX_YEAR, "year");
    const brand = needText(args.brand, MAX_BRAND, "brand");
    const name = needText(args.name, MAX_SET_NAME, "set name");
    const notes = cleanText(args.notes, MAX_NOTES, "note");
    const searched = cleanText(args.searched, MAX_SEARCHED, "search");
    await checkCaps(ctx, ownerId, true);
    const now = Date.now();
    const requestId = await ctx.db.insert("cardRequests", {
      ownerId,
      kind: "set",
      status: "waiting",
      ...(searched ? { searched } : {}),
      ...(notes ? { notes } : {}),
      label: privateSetLabel({ year, brand, name }),
      lastUpdated: now,
    });
    const privateSetId = await ctx.db.insert("privateSets", {
      ownerId,
      requestId,
      sportId: args.sportId,
      year,
      brand,
      name,
      lastUpdated: now,
    });
    await ctx.db.patch(requestId, { privateSetId });
    return { requestId, privateSetId };
  },
});

/**
 * A card in one of the caller's requested sets: a private card filed under
 * the set request (no new request). `variantName` is its checklist as typed
 * ("Base", "Gold /50"). Refused once the set is NB's (approved): file it as
 * the NB card instead.
 */
export const addPrivateCard = mutation({
  args: {
    privateSetId: v.id("privateSets"),
    variantName: v.string(),
    cardNumber: v.string(),
    player: v.string(),
    notes: v.optional(v.string()),
    ...photoArgs,
  },
  returns: v.object({ privateCardId: v.id("privateCards") }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const set = await ctx.db.get(args.privateSetId);
    if (!set || set.ownerId !== ownerId) {
      refuse(COLLECTION_ERRORS.notFound, "That set isn't one you asked for.");
    }
    const request = await ownRequest(ctx, ownerId, set.requestId);
    if (request.status === "added") {
      refuse(COLLECTION_ERRORS.invalid, "That set is in the catalog now. Find the card there instead.");
    }
    const variantName = needText(args.variantName, MAX_VARIANT_NAME, "checklist name");
    const cardNumber = cleanNumber(args.cardNumber);
    const player = needText(args.player, MAX_PLAYER, "player");
    const notes = cleanText(args.notes, MAX_NOTES, "note");
    const frontImageId = await checkPhoto(ctx, args.frontImageId);
    const backImageId = await checkPhoto(ctx, args.backImageId);
    await checkCaps(ctx, ownerId, false);
    const inSet = await ctx.db
      .query("privateCards")
      .withIndex("by_private_set", (q) => q.eq("privateSetId", set._id))
      .take(MAX_PRIVATE_SET_CARDS);
    if (inSet.length >= MAX_PRIVATE_SET_CARDS) {
      refuse(COLLECTION_ERRORS.limit, `That set has ${MAX_PRIVATE_SET_CARDS} of your cards already.`);
    }
    const now = Date.now();
    const privateCardId = await ctx.db.insert("privateCards", {
      ownerId,
      requestId: request._id,
      privateSetId: set._id,
      variantName,
      cardNumber,
      player,
      ...(notes ? { notes } : {}),
      ...(frontImageId ? { frontImageId } : {}),
      ...(backImageId ? { backImageId } : {}),
      lastUpdated: now,
    });
    await ctx.db.patch(request._id, { lastUpdated: now });
    return { privateCardId };
  },
});

/**
 * Withdraw a waiting request, or drop a declined one: deletes it, the private
 * card or set it made, every private card in that set, and every copy of
 * them. An added request has nothing private left to withdraw. Refuses past
 * `MAX_WITHDRAW_LINES` copy lines (remove some first) rather than half-do it.
 */
export const withdraw = mutation({
  args: { requestId: v.id("cardRequests") },
  returns: v.object({ copies: v.number(), cards: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const request = await ownRequest(ctx, ownerId, args.requestId);
    if (request.status === "added") {
      refuse(COLLECTION_ERRORS.invalid, "That one is in the catalog now, so there's nothing to withdraw.");
    }
    const cards = await cardsOfRequest(ctx, request);
    const held = await copiesOfCards(ctx, cards);
    if (held.lines > MAX_WITHDRAW_LINES) {
      refuse(
        COLLECTION_ERRORS.limit,
        `That would remove more than ${MAX_WITHDRAW_LINES} lines of cards at once. Remove some copies first.`,
      );
    }
    for (const card of cards) await deletePrivateCard(ctx, card);
    if (request.privateSetId && (await ctx.db.get(request.privateSetId))) {
      await ctx.db.delete(request.privateSetId);
    }
    await ctx.db.delete(request._id);
    return { copies: held.copies, cards: cards.length };
  },
});

/**
 * After a set request is added: file one of the caller's private cards from
 * it as an NB card in that set ("this is the one"). Moves every copy onto
 * the NB card and deletes the private card; the private set goes with its
 * last card.
 */
export const fileAs = mutation({
  args: { privateCardId: v.id("privateCards"), cardId: v.id("cardChecklist") },
  returns: v.object({ moved: v.number() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const card = await ctx.db.get(args.privateCardId);
    if (!card || card.ownerId !== ownerId || !card.privateSetId) {
      refuse(COLLECTION_ERRORS.notFound, "That card isn't one of yours from a requested set.");
    }
    const request = await ownRequest(ctx, ownerId, card.requestId);
    if (request.status !== "added" || !request.addedSetId) {
      refuse(COLLECTION_ERRORS.invalid, "That set isn't in the catalog yet.");
    }
    const target = await ctx.db.get(args.cardId);
    const targetSet = target ? await findSetForSelectorOption(ctx, target.selectorOptionId) : undefined;
    if (!target || targetSet !== request.addedSetId) {
      refuse(COLLECTION_ERRORS.invalid, "Pick a card from that set.");
    }
    const moved = await moveOntoCatalogCard(ctx, ownerId, card._id, args.cardId);
    const privateSetId = card.privateSetId;
    await discardPrivateCard(ctx, card);
    const left = await ctx.db
      .query("privateCards")
      .withIndex("by_private_set", (q) => q.eq("privateSetId", privateSetId))
      .first();
    if (!left) {
      if (await ctx.db.get(privateSetId)) await ctx.db.delete(privateSetId);
      await ctx.db.patch(request._id, { privateSetId: undefined, lastUpdated: Date.now() });
    }
    return { moved };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Collector reads
// ───────────────────────────────────────────────────────────────────────────

/** The caller's requests, newest first, with what a withdraw would remove. */
export const mine = query({
  args: {},
  returns: v.array(myRequestValidator),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const rows = await ctx.db
      .query("cardRequests")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(MAX_REQUEST_LIST);
    const out = [];
    for (const row of rows) {
      const cards = row.status === "added" && !row.privateSetId ? [] : await cardsOfRequest(ctx, row);
      const held = await copiesOfCards(ctx, cards);
      out.push({
        _id: row._id,
        kind: row.kind,
        status: row.status,
        label: row.label,
        ...(row.notes ? { notes: row.notes } : {}),
        ...(row.decisionNote ? { decisionNote: row.decisionNote } : {}),
        ...(row.decidedAt !== undefined ? { decidedAt: row.decidedAt } : {}),
        requestedAt: row._creationTime,
        ...(row.privateCardId ? { privateCardId: row.privateCardId } : {}),
        ...(row.privateSetId ? { privateSetId: row.privateSetId } : {}),
        ...(row.addedCardId ? { addedCardId: row.addedCardId } : {}),
        ...(row.addedSetId ? { addedSetId: row.addedSetId } : {}),
        copies: held.copies,
        cards: cards.length,
      });
    }
    return out;
  },
});

/**
 * Several of the caller's private cards, aligned with `ids`: null in place
 * of a bad id, a gone card, or anyone else's (which reads like a gone one).
 * The collection's card hydration asks this for every id the catalog read
 * did not know.
 */
export const privateCards = query({
  args: { ids: v.array(v.string()) },
  returns: v.array(v.union(privateCardValidator, v.null())),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    if (args.ids.length > MAX_LINES_PER_CARD) {
      refuse(COLLECTION_ERRORS.limit, `At most ${MAX_LINES_PER_CARD} cards at once.`);
    }
    const reader = new CatalogReader(ctx);
    const out = [];
    for (const raw of args.ids) {
      const id = ctx.db.normalizeId("privateCards", raw);
      const row = id ? await ctx.db.get(id) : null;
      out.push(row && row.ownerId === ownerId ? await privateCardOut(ctx, reader, row) : null);
    }
    return out;
  },
});

/** The caller's requested sets that still take private cards (not yet added). */
export const mySets = query({
  args: {},
  returns: v.array(privateSetValidator),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const rows = await ctx.db
      .query("privateSets")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .take(MAX_REQUEST_LIST);
    const reader = new CatalogReader(ctx);
    const out = [];
    for (const row of rows) {
      const set = await privateSetOut(ctx, reader, row);
      if (set.status !== "added") out.push(set);
    }
    return out;
  },
});

/** The caller's private cards in one of their requested sets. */
export const privateSetCards = query({
  args: { privateSetId: v.string() },
  returns: v.array(privateCardValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const id = ctx.db.normalizeId("privateSets", args.privateSetId);
    const set = id ? await ctx.db.get(id) : null;
    if (!set || set.ownerId !== ownerId) return [];
    const rows = await ctx.db
      .query("privateCards")
      .withIndex("by_private_set", (q) => q.eq("privateSetId", set._id))
      .take(MAX_PRIVATE_SET_CARDS);
    const reader = new CatalogReader(ctx);
    const out = [];
    for (const row of rows) out.push(await privateCardOut(ctx, reader, row));
    return out;
  },
});

/**
 * For a card of the caller's that is still private after its set was added:
 * the NB cards in that set with its number, to pick the one it is
 * (`fileAs`). Empty for any other card.
 */
export const fileCandidates = query({
  args: { privateCardId: v.string() },
  returns: v.array(catalogCardWithPathValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const id = ctx.db.normalizeId("privateCards", args.privateCardId);
    const card = id ? await ctx.db.get(id) : null;
    if (!card || card.ownerId !== ownerId) return [];
    const request = await ctx.db.get(card.requestId);
    if (request?.status !== "added" || !request.addedSetId) return [];
    return await sameNumberIn(ctx, new CatalogReader(ctx), request.addedSetId, card.cardNumber);
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Admin review
// ───────────────────────────────────────────────────────────────────────────

/** Waiting requests, for the admin nav's count. Capped at `MAX_REQUEST_LIST` (read "200+"). */
export const waitingCount = query({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const rows = await ctx.db
      .query("cardRequests")
      .withIndex("by_status", (q) => q.eq("status", "waiting"))
      .take(MAX_REQUEST_LIST);
    return rows.length;
  },
});

/** The admin queue: requests in `status` (default waiting), oldest first. */
export const queue = query({
  args: { status: v.optional(cardRequestStatusValidator) },
  returns: v.array(queueItemValidator),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const status = args.status ?? "waiting";
    const rows = await ctx.db
      .query("cardRequests")
      .withIndex("by_status", (q) => q.eq("status", status))
      .order(status === "waiting" ? "asc" : "desc")
      .take(MAX_REQUEST_LIST);
    const out = [];
    for (const row of rows) {
      const card = row.privateCardId ? await ctx.db.get(row.privateCardId) : null;
      out.push({
        _id: row._id,
        kind: row.kind,
        status: row.status,
        label: row.label,
        ownerId: row.ownerId,
        requestedAt: row._creationTime,
        hasPhotos: Boolean(card?.frontImageId || card?.backImageId),
      });
    }
    return out;
  },
});

/**
 * One request in full, for the admin's review: what was asked, the private
 * card or set it made (photos included), and, for a card request, the NB
 * cards in that set already carrying that number (likely a parallel or a
 * misread: a match to confirm, never one to take on its own).
 */
export const review = query({
  args: { requestId: v.string() },
  returns: v.union(
    v.object({
      _id: v.id("cardRequests"),
      kind: cardRequestKindValidator,
      status: cardRequestStatusValidator,
      label: v.string(),
      ownerId: v.string(),
      requestedAt: v.number(),
      searched: v.optional(v.string()),
      notes: v.optional(v.string()),
      decisionNote: v.optional(v.string()),
      decidedAt: v.optional(v.number()),
      addedCardId: v.optional(v.id("cardChecklist")),
      addedSetId: v.optional(v.id("selectorOptions")),
      privateCard: v.union(privateCardValidator, v.null()),
      privateSet: v.union(privateSetValidator, v.null()),
      privateSetCards: v.array(privateCardValidator),
      sameNumber: v.array(catalogCardWithPathValidator),
      /** Physical copies the collector holds of what this request made. */
      copies: v.number(),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const id = ctx.db.normalizeId("cardRequests", args.requestId);
    const row = id ? await ctx.db.get(id) : null;
    if (!row) return null;
    const reader = new CatalogReader(ctx);
    const card = row.privateCardId ? await ctx.db.get(row.privateCardId) : null;
    const set = row.privateSetId ? await ctx.db.get(row.privateSetId) : null;
    const setCards = set
      ? await ctx.db
          .query("privateCards")
          .withIndex("by_private_set", (q) => q.eq("privateSetId", set._id))
          .take(MAX_PRIVATE_SET_CARDS)
      : [];
    const sameNumber = card?.setId
      ? await sameNumberIn(ctx, reader, card.setId, card.cardNumber, card.variantId)
      : [];
    const held = await copiesOfCards(ctx, card ? [card] : setCards);
    const privateSetCards = [];
    for (const c of setCards) privateSetCards.push(await privateCardOut(ctx, reader, c));
    return {
      _id: row._id,
      kind: row.kind,
      status: row.status,
      label: row.label,
      ownerId: row.ownerId,
      requestedAt: row._creationTime,
      ...(row.searched ? { searched: row.searched } : {}),
      ...(row.notes ? { notes: row.notes } : {}),
      ...(row.decisionNote ? { decisionNote: row.decisionNote } : {}),
      ...(row.decidedAt !== undefined ? { decidedAt: row.decidedAt } : {}),
      ...(row.addedCardId ? { addedCardId: row.addedCardId } : {}),
      ...(row.addedSetId ? { addedSetId: row.addedSetId } : {}),
      privateCard: card ? await privateCardOut(ctx, reader, card) : null,
      privateSet: set ? await privateSetOut(ctx, reader, set) : null,
      privateSetCards,
      sameNumber,
      copies: held.copies,
    };
  },
});

/**
 * Approve a card request as the NB card `cardId`: one already in the catalog,
 * or one the admin just added with the set builder's quick add. The
 * collector's copies move onto it and their private card goes. A declined
 * request can be approved later (a change of mind).
 */
export const approveCard = mutation({
  args: {
    requestId: v.id("cardRequests"),
    cardId: v.id("cardChecklist"),
    note: v.optional(v.string()),
  },
  returns: v.object({ moved: v.number() }),
  handler: async (ctx, args) => {
    const adminId = await requireAdmin(ctx);
    const request = await anyRequest(ctx, args.requestId);
    if (request.kind !== "card") refuse(COLLECTION_ERRORS.invalid, "That's a set request. Approve it as a set.");
    if (request.status === "added") refuse(COLLECTION_ERRORS.invalid, "That request is already added.");
    const note = cleanText(args.note, MAX_DECISION_NOTE, "note");
    let moved = 0;
    const card = request.privateCardId ? await ctx.db.get(request.privateCardId) : null;
    if (card) {
      moved = await moveOntoCatalogCard(ctx, request.ownerId, card._id, args.cardId);
      await discardPrivateCard(ctx, card);
    } else if (!(await ctx.db.get(args.cardId))) {
      refuse(COLLECTION_ERRORS.notFound, "That card isn't in the catalog anymore.");
    }
    const now = Date.now();
    await ctx.db.patch(request._id, {
      status: "added",
      addedCardId: args.cardId,
      privateCardId: undefined,
      decisionNote: note,
      decidedBy: adminId,
      decidedAt: now,
      lastUpdated: now,
    });
    return { moved };
  },
});

/**
 * Approve a set request as the NB set `setId` (built in the set builder).
 * Each of the collector's private cards in the requested set whose number
 * names EXACTLY ONE card in `setId` moves onto it (invariant 7: never on a
 * number without that guard). The others stay private for the collector to
 * file themselves (`fileAs`); so does anything past this call's budget.
 */
export const approveSet = mutation({
  args: {
    requestId: v.id("cardRequests"),
    setId: v.id("selectorOptions"),
    note: v.optional(v.string()),
  },
  returns: v.object({ matched: v.number(), left: v.number() }),
  handler: async (ctx, args) => {
    const adminId = await requireAdmin(ctx);
    const request = await anyRequest(ctx, args.requestId);
    if (request.kind !== "set") refuse(COLLECTION_ERRORS.invalid, "That's a card request. Approve it as a card.");
    if (request.status === "added") refuse(COLLECTION_ERRORS.invalid, "That request is already added.");
    const set = await ctx.db.get(args.setId);
    if (!set || set.level !== "setName") refuse(COLLECTION_ERRORS.notFound, "Pick a set from the catalog.");
    const note = cleanText(args.note, MAX_DECISION_NOTE, "note");

    const variants: Array<Id<"selectorOptions">> = [];
    await walkSetVariants(ctx, args.setId, async (variant) => {
      if (variants.length >= MAX_SET_VARIANTS) return false;
      variants.push(variant._id);
      return true;
    });
    const cards = await cardsOfRequest(ctx, request);
    const budget = { lookups: MAX_APPROVE_SET_LOOKUPS, lines: MAX_APPROVE_SET_LINES };
    let matched = 0;
    for (const card of cards) {
      if (budget.lookups < variants.length) break;
      const hits: Array<Id<"cardChecklist">> = [];
      for (const variantId of variants) {
        budget.lookups -= 1;
        const found = await ctx.db
          .query("cardChecklist")
          .withIndex("by_selector_option_and_number", (q) =>
            q.eq("selectorOptionId", variantId).eq("cardNumber", card.cardNumber),
          )
          .take(2);
        hits.push(...found.map((c) => c._id));
        if (hits.length > 1) break;
      }
      if (hits.length !== 1) continue;
      const lines = await linesOf(ctx, request.ownerId, card._id);
      if (lines.length > budget.lines) break;
      // A card that couldn't join (the collector already holds the most
      // lines one card takes) stays private for them to sort, rather than
      // refusing the whole approval.
      const held = await linesOf(ctx, request.ownerId, hits[0]);
      if (held.length + lines.length > MAX_LINES_PER_CARD) continue;
      budget.lines -= lines.length;
      await moveOntoCatalogCard(ctx, request.ownerId, card._id, hits[0]);
      await discardPrivateCard(ctx, card);
      matched += 1;
    }
    const left = cards.length - matched;
    if (left === 0 && request.privateSetId && (await ctx.db.get(request.privateSetId))) {
      await ctx.db.delete(request.privateSetId);
    }
    const now = Date.now();
    await ctx.db.patch(request._id, {
      status: "added",
      addedSetId: args.setId,
      ...(left === 0 ? { privateSetId: undefined } : {}),
      decisionNote: note,
      decidedBy: adminId,
      decidedAt: now,
      lastUpdated: now,
    });
    return { matched, left };
  },
});

/** Decline a waiting request, with an optional note the collector sees. Their private card or set stays theirs. */
export const decline = mutation({
  args: { requestId: v.id("cardRequests"), note: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const adminId = await requireAdmin(ctx);
    const request = await anyRequest(ctx, args.requestId);
    if (request.status !== "waiting") refuse(COLLECTION_ERRORS.invalid, "That request isn't waiting anymore.");
    const note = cleanText(args.note, MAX_DECISION_NOTE, "note");
    const now = Date.now();
    await ctx.db.patch(request._id, {
      status: "declined",
      decisionNote: note,
      decidedBy: adminId,
      decidedAt: now,
      lastUpdated: now,
    });
    return null;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Upkeep
// ───────────────────────────────────────────────────────────────────────────

/**
 * Hourly (crons.ts): delete upload tickets over an hour old, and every
 * stored photo from the last day that is over an hour old and on no card (an
 * upload the collector never sent, or one a send refused). Convex storage
 * holds nothing but these photos. Each run looks at a bounded batch and
 * schedules itself on from where it stopped.
 */
export const sweepPhotoUploads = internalMutation({
  args: { after: v.optional(v.number()) },
  returns: v.object({ tickets: v.number(), photos: v.number() }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - PHOTO_UPLOAD_TTL_MS;
    const oldTickets = await ctx.db
      .query("photoUploadTickets")
      .withIndex("by_created", (q) => q.lt("createdAt", cutoff))
      .take(PHOTO_SWEEP_BATCH);
    for (const t of oldTickets) await ctx.db.delete(t._id);

    const from = args.after ?? cutoff - 24 * PHOTO_UPLOAD_TTL_MS;
    const files = await ctx.db.system
      .query("_storage")
      .withIndex("by_creation_time", (q) => q.gt("_creationTime", from).lt("_creationTime", cutoff))
      .take(PHOTO_SWEEP_BATCH);
    let photos = 0;
    for (const file of files) {
      if (await photoInUse(ctx, file._id)) continue;
      await ctx.storage.delete(file._id);
      photos += 1;
    }
    if (files.length === PHOTO_SWEEP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.collectionRequests.sweepPhotoUploads, {
        after: files[files.length - 1]._creationTime,
      });
    }
    return { tickets: oldTickets.length, photos };
  },
});
