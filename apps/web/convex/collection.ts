/**
 * NEO-358 — a collector's own cards: the copies they hold, where those live,
 * and the sets they are building.
 *
 * Every function is signed-in (`requireSignedIn`) and reads or writes ONLY the
 * caller's rows: `ownerId` is the caller's Clerk subject, never an argument,
 * and every write that names an existing row checks it belongs to the caller
 * first. A row that is not the caller's reads exactly like a row that does
 * not exist, so a guessed id learns nothing.
 *
 * ## One pile per row, folded server-side
 *
 * A `collectionCopies` row is one physical copy or a stack of identical ones,
 * with exactly one home. `addLineItem` folds a new copy into an existing row
 * when EVERY field matches (condition, grading, cost, acquired, location,
 * notes, home); a copy carrying a grading cert or a serial number is one of a
 * kind and never folds. The fold lives here and nowhere else.
 *
 * ## Undo
 *
 * Every write returns what it takes to reverse it: an add says whether it
 * merged (undo = `updateCopy` back to `previous`) or inserted (undo =
 * `removeCopy`); `updateCopy` returns `previous`; `removeCopy` returns the
 * removed row's card and details (undo = `restoreCopy`). Copies are hard
 * deleted.
 *
 * ## No cap on a collection, so nothing walks it
 *
 * Jason, 2026-10-23: there is no per-account copy cap; dealers will hold tens
 * of thousands of cards. So "how many do I own" is a TALLY kept on the
 * collector's Main binder and moved by every write here in the same
 * transaction (`moveTally`), and "everything I own" is PAGED
 * (`ownedCards`, most recently touched first). Neither reads the whole pile.
 */

import { ConvexError, v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireSignedIn } from "./auth";
import { findSetForSelectorOption } from "./lib/selectorAncestry";
import { CatalogReader, cardTotals, setRefValidator } from "./lib/catalogView";
import {
  collectionCopyConditionValidator,
  collectionCopyGradingValidator,
} from "./schema";
import type { collectionTallyValidator } from "./schema";

type CopyRow = Doc<"collectionCopies">;

/** Copies one row may stack. */
export const MAX_COPY_QUANTITY = 999;
/** Line items one collector may hold of one card. Bounds the fold scan. */
export const MAX_LINES_PER_CARD = 200;
/** Cards `addHaves` and copies `removeCopies` take per call. */
export const MAX_BATCH = 200;
/** Lines one variant's copy list reads. */
export const MAX_VARIANT_COPIES = 2000;
/** Lines `setCompletion` reads for one set. */
export const MAX_SUMMARY_LINES = 5000;
/**
 * Lines a hand count of a collector's tally reads (`recountTally`): only for
 * a collector whose tally was never kept, or drifted. Past it the count is
 * not exact, and the summary says so.
 */
export const MAX_TALLY_RECOUNT_LINES = 5000;
/**
 * Line items one `ownedCards` page reads. Each listed card also reads its own
 * lines (at most `MAX_LINES_PER_CARD`), so a page reads at most
 * 64 + 64 x 200 documents.
 */
export const MAX_OWNED_PAGE_LINES = 64;
/** Sets one collector may mark as building. */
export const MAX_BUILDING_SETS = 200;
/** Cards a completion query may count by hand for an uncounted row. */
const COMPLETION_COUNT_BUDGET = 4000;

const MAX_GRADE_CHARS = 20;
const MAX_CERT_CHARS = 40;
const MAX_SERIAL_CHARS = 20;
const MAX_LOCATION_CHARS = 120;
const MAX_NOTES_CHARS = 2000;
/** $100,000,000.00 in cents: far above any card, below float trouble. */
const MAX_COST_CENTS = 10_000_000_000;

/** The default home every add lands in until containers are user-facing. */
export const MAIN_CONTAINER_NAME = "Main";

/** The `ConvexError` codes this module throws. */
export const COLLECTION_ERRORS = {
  notFound: "COLLECTION_NOT_FOUND",
  invalid: "COLLECTION_INVALID",
  limit: "COLLECTION_LIMIT",
} as const;

// ───────────────────────────────────────────────────────────────────────────
// Validators
// ───────────────────────────────────────────────────────────────────────────

/**
 * Everything about a copy the collector edits. On a write, an absent optional
 * field means "none" (an edit replaces the whole set of details), and an
 * absent `homeId` means the Main binder. On a read, `homeId` is always there.
 */
export const copyDetailsFields = {
  quantity: v.number(),
  condition: v.optional(collectionCopyConditionValidator),
  grading: v.optional(collectionCopyGradingValidator),
  serialNumber: v.optional(v.string()),
  /** Integer cents, per copy. */
  costCents: v.optional(v.number()),
  /** `YYYY-MM-DD`. */
  acquiredOn: v.optional(v.string()),
  location: v.optional(v.string()),
  notes: v.optional(v.string()),
  homeId: v.optional(v.id("collectionContainers")),
};
export const copyDetailsValidator = v.object(copyDetailsFields);

/** A copy as the collector's screens read it. */
export const copyValidator = v.object({
  _id: v.id("collectionCopies"),
  cardId: v.id("cardChecklist"),
  variantId: v.id("selectorOptions"),
  setId: v.id("selectorOptions"),
  homeId: v.id("collectionContainers"),
  quantity: v.number(),
  condition: v.optional(collectionCopyConditionValidator),
  grading: v.optional(collectionCopyGradingValidator),
  serialNumber: v.optional(v.string()),
  costCents: v.optional(v.number()),
  acquiredOn: v.optional(v.string()),
  location: v.optional(v.string()),
  notes: v.optional(v.string()),
  lastUpdated: v.number(),
});

/** What an add did: merged into an existing row, or inserted a new one. */
export const addResultValidator = v.object({
  copyId: v.id("collectionCopies"),
  merged: v.boolean(),
  /** On a merge, the row's details before it (undo = `updateCopy` with these). */
  previous: v.optional(copyDetailsValidator),
});

/** A removed row: enough for `restoreCopy` to put it back. */
export const removedCopyValidator = v.object({
  cardId: v.id("cardChecklist"),
  details: copyDetailsValidator,
});

type DetailsArg = typeof copyDetailsValidator.type;
type StoredDetails = Omit<DetailsArg, "homeId"> & {
  homeId: Id<"collectionContainers">;
};

// ───────────────────────────────────────────────────────────────────────────
// Rules
// ───────────────────────────────────────────────────────────────────────────

function refuse(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

/** Trimmed text, or undefined for blank. Refuses text over `max`. */
function cleanText(raw: string | undefined, max: number, what: string): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) {
    refuse(COLLECTION_ERRORS.invalid, `That ${what} is too long. Keep it under ${max} characters.`);
  }
  return trimmed;
}

/** A real calendar date in `YYYY-MM-DD`. */
export function isIsoDate(raw: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * The details as they are stored: trimmed, blank text dropped, every number
 * checked. Refuses with a `ConvexError` the copy form can show. Home is
 * resolved separately (`resolveHome`).
 */
export function cleanDetails(raw: DetailsArg): Omit<StoredDetails, "homeId"> {
  if (!Number.isInteger(raw.quantity) || raw.quantity < 1 || raw.quantity > MAX_COPY_QUANTITY) {
    refuse(COLLECTION_ERRORS.invalid, `Quantity is a whole number from 1 to ${MAX_COPY_QUANTITY}.`);
  }
  let grading: StoredDetails["grading"];
  if (raw.grading) {
    const grade = cleanText(raw.grading.grade, MAX_GRADE_CHARS, "grade");
    if (!grade) refuse(COLLECTION_ERRORS.invalid, "A graded card needs its grade.");
    const cert = cleanText(raw.grading.cert, MAX_CERT_CHARS, "cert number");
    grading = { grader: raw.grading.grader, grade, ...(cert ? { cert } : {}) };
  }
  const serialNumber = cleanText(raw.serialNumber, MAX_SERIAL_CHARS, "serial number");
  if ((grading?.cert || serialNumber) && raw.quantity !== 1) {
    refuse(
      COLLECTION_ERRORS.invalid,
      "A card with a cert or serial number is one of a kind, so its quantity is 1.",
    );
  }
  if (raw.costCents !== undefined) {
    if (!Number.isSafeInteger(raw.costCents) || raw.costCents < 0 || raw.costCents > MAX_COST_CENTS) {
      refuse(COLLECTION_ERRORS.invalid, "Cost needs to be a dollar amount of zero or more.");
    }
  }
  let acquiredOn: string | undefined;
  if (raw.acquiredOn !== undefined && raw.acquiredOn.trim() !== "") {
    acquiredOn = raw.acquiredOn.trim();
    if (!isIsoDate(acquiredOn)) {
      refuse(COLLECTION_ERRORS.invalid, "That acquired date isn't a real date.");
    }
  }
  const location = cleanText(raw.location, MAX_LOCATION_CHARS, "location");
  const notes = cleanText(raw.notes, MAX_NOTES_CHARS, "note");
  return {
    quantity: raw.quantity,
    ...(raw.condition ? { condition: raw.condition } : {}),
    ...(grading ? { grading } : {}),
    ...(serialNumber ? { serialNumber } : {}),
    ...(raw.costCents !== undefined ? { costCents: raw.costCents } : {}),
    ...(acquiredOn ? { acquiredOn } : {}),
    ...(location ? { location } : {}),
    ...(notes ? { notes } : {}),
  };
}

/** One of a kind: a cert or a serial number. Never folds, either way. */
export function isOneOfAKind(d: { grading?: { cert?: string }; serialNumber?: string }): boolean {
  return Boolean(d.grading?.cert || d.serialNumber);
}

/**
 * The fold rule: may a new copy with `next` details join `row`? Only when
 * neither is one of a kind and every other field is identical, home included.
 */
export function foldsInto(row: StoredDetails, next: StoredDetails): boolean {
  if (isOneOfAKind(row) || isOneOfAKind(next)) return false;
  return (
    row.homeId === next.homeId &&
    row.condition === next.condition &&
    row.grading?.grader === next.grading?.grader &&
    row.grading?.grade === next.grading?.grade &&
    row.costCents === next.costCents &&
    row.acquiredOn === next.acquiredOn &&
    row.location === next.location &&
    row.notes === next.notes
  );
}

/** A copy row's details, in the write shape (for `previous` and `removed`). */
function detailsOf(row: CopyRow): StoredDetails {
  return {
    quantity: row.quantity,
    ...(row.condition ? { condition: row.condition } : {}),
    ...(row.grading ? { grading: row.grading } : {}),
    ...(row.serialNumber ? { serialNumber: row.serialNumber } : {}),
    ...(row.costCents !== undefined ? { costCents: row.costCents } : {}),
    ...(row.acquiredOn ? { acquiredOn: row.acquiredOn } : {}),
    ...(row.location ? { location: row.location } : {}),
    ...(row.notes ? { notes: row.notes } : {}),
    homeId: row.homeId,
  };
}

function copyOut(row: CopyRow): typeof copyValidator.type {
  return {
    _id: row._id,
    cardId: row.cardId,
    variantId: row.variantId,
    setId: row.setId,
    ...detailsOf(row),
    lastUpdated: row.lastUpdated,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Reads and writes shared by the handlers
// ───────────────────────────────────────────────────────────────────────────

/** The caller's Main binder, made on first use. */
async function getOrCreateMain(
  ctx: MutationCtx,
  ownerId: string,
): Promise<Id<"collectionContainers">> {
  const existing = await ctx.db
    .query("collectionContainers")
    .withIndex("by_owner_and_system", (q) =>
      q.eq("ownerId", ownerId).eq("system", "main"),
    )
    .unique();
  if (existing) return existing._id;
  return await ctx.db.insert("collectionContainers", {
    ownerId,
    kind: "binder",
    system: "main",
    name: MAIN_CONTAINER_NAME,
    lastUpdated: Date.now(),
  });
}

type Tally = typeof collectionTallyValidator.type;

const NO_CHANGE: Tally = { copies: 0, lines: 0, cards: 0 };

function addTallies(a: Tally, b: Tally): Tally {
  return { copies: a.copies + b.copies, lines: a.lines + b.lines, cards: a.cards + b.cards };
}

/**
 * The caller's tally counted by hand, from at most `MAX_TALLY_RECOUNT_LINES`
 * line items. `exact` is false when there were more: the numbers are then a
 * floor, never the answer.
 */
async function recountTally(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<{ tally: Tally; exact: boolean }> {
  const rows = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId))
    .take(MAX_TALLY_RECOUNT_LINES + 1);
  const exact = rows.length <= MAX_TALLY_RECOUNT_LINES;
  const counted = exact ? rows : rows.slice(0, MAX_TALLY_RECOUNT_LINES);
  let copies = 0;
  for (const row of counted) copies += row.quantity;
  return {
    tally: { copies, lines: counted.length, cards: distinctCards(counted).size },
    exact,
  };
}

/**
 * Move the caller's tally by `delta`, AFTER the write it describes, in the
 * same transaction. The tally lives on Main (see the schema); a collector
 * without one yet, or one whose tally would go below zero (drift), is counted
 * by hand instead, and left uncounted when even that is too big to finish.
 */
async function moveTally(ctx: MutationCtx, ownerId: string, delta: Tally): Promise<void> {
  if (delta.copies === 0 && delta.lines === 0 && delta.cards === 0) return;
  const mainId = await getOrCreateMain(ctx, ownerId);
  const main = await ctx.db.get(mainId);
  const stored = main?.tally;
  if (stored) {
    const next = addTallies(stored, delta);
    if (next.copies >= 0 && next.lines >= 0 && next.cards >= 0) {
      await ctx.db.patch(mainId, { tally: next });
      return;
    }
    console.warn(JSON.stringify({ event: "collection_tally_drift", stored, delta }));
  }
  const counted = await recountTally(ctx, ownerId);
  await ctx.db.patch(mainId, { tally: counted.exact ? counted.tally : undefined });
}

/** Is any line of this card still the caller's? (After a delete: did a distinct card go?) */
async function stillHolds(
  ctx: MutationCtx,
  ownerId: string,
  cardId: Id<"cardChecklist">,
): Promise<boolean> {
  const line = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", cardId))
    .first();
  return line !== null;
}

/**
 * The home a write names, checked: the caller's own container, and not a
 * system container other than Main (a future want list is never a home).
 * Absent means Main.
 */
async function resolveHome(
  ctx: MutationCtx,
  ownerId: string,
  homeId: Id<"collectionContainers"> | undefined,
): Promise<Id<"collectionContainers">> {
  if (homeId === undefined) return await getOrCreateMain(ctx, ownerId);
  const home = await ctx.db.get(homeId);
  if (!home || home.ownerId !== ownerId) {
    refuse(COLLECTION_ERRORS.notFound, "That binder isn't in your collection.");
  }
  if (home.system !== undefined && home.system !== "main") {
    refuse(COLLECTION_ERRORS.invalid, "Cards can't live there. Pick a binder or a box.");
  }
  return home._id;
}

/** Where a card files: its variant row and that row's set. Refuses a gone card. */
async function placeOf(
  ctx: MutationCtx,
  cardId: Id<"cardChecklist">,
): Promise<{ variantId: Id<"selectorOptions">; setId: Id<"selectorOptions"> }> {
  const card = await ctx.db.get(cardId);
  if (!card) {
    refuse(COLLECTION_ERRORS.notFound, "That card isn't in the catalog anymore.");
  }
  const setId = await findSetForSelectorOption(ctx, card.selectorOptionId);
  if (!setId) {
    refuse(COLLECTION_ERRORS.notFound, "That card isn't filed under a set yet, so it can't be added.");
  }
  return { variantId: card.selectorOptionId, setId };
}

/** The caller's copy, or a not-found refusal. */
async function ownCopy(
  ctx: MutationCtx,
  ownerId: string,
  copyId: Id<"collectionCopies">,
): Promise<CopyRow> {
  const row = await ctx.db.get(copyId);
  if (!row || row.ownerId !== ownerId) {
    refuse(COLLECTION_ERRORS.notFound, "That copy isn't in your collection.");
  }
  return row;
}

/**
 * Add one line item, folding when the rule allows. Returns how the caller's
 * tally moves; the caller applies it (`moveTally`) once, after all its adds.
 */
async function addOne(
  ctx: MutationCtx,
  ownerId: string,
  cardId: Id<"cardChecklist">,
  raw: DetailsArg,
): Promise<{ result: typeof addResultValidator.type; delta: Tally }> {
  const cleaned = cleanDetails(raw);
  const homeId = await resolveHome(ctx, ownerId, raw.homeId);
  const next: StoredDetails = { ...cleaned, homeId };
  const place = await placeOf(ctx, cardId);
  const lines = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", cardId))
    .take(MAX_LINES_PER_CARD + 1);
  const now = Date.now();
  const into = lines.find((row) => foldsInto(detailsOf(row), next));
  if (into) {
    const quantity = into.quantity + next.quantity;
    if (quantity > MAX_COPY_QUANTITY) {
      refuse(COLLECTION_ERRORS.limit, `That stack would pass ${MAX_COPY_QUANTITY} copies. Start a new line for the rest.`);
    }
    const previous = detailsOf(into);
    await ctx.db.patch(into._id, { quantity, lastUpdated: now });
    return {
      result: { copyId: into._id, merged: true, previous },
      delta: { copies: next.quantity, lines: 0, cards: 0 },
    };
  }
  if (lines.length >= MAX_LINES_PER_CARD) {
    refuse(COLLECTION_ERRORS.limit, `You already have ${MAX_LINES_PER_CARD} lines of this card. Stack some together first.`);
  }
  const copyId = await ctx.db.insert("collectionCopies", {
    ownerId,
    cardId,
    variantId: place.variantId,
    setId: place.setId,
    ...next,
    lastUpdated: now,
  });
  return {
    result: { copyId, merged: false },
    delta: { copies: next.quantity, lines: 1, cards: lines.length === 0 ? 1 : 0 },
  };
}

/** A fresh copy of a card: one raw card in Main. */
function haveDetails(acquiredOn: string | undefined): DetailsArg {
  return { quantity: 1, ...(acquiredOn ? { acquiredOn } : {}) };
}

/** Distinct cards among copy rows. */
function distinctCards(rows: CopyRow[]): Set<string> {
  return new Set(rows.map((r) => r.cardId as string));
}

/**
 * How many of `cardIds` sit on `variantId` today: `owned` counts the regular
 * cards (no `variationOfCardId`), `ownedAll` every one. Gone cards don't
 * count. Neither does a card that has MOVED off the variant while its copies
 * still name it: `setShapeMove.moveCards` re-points the first
 * `MAX_COPIES_PER_MOVE` copies in the move and pages the rest
 * (`repointMovedCardCopies`), so for that short window a copy's `variantId` is
 * stale, and an owned count must never read past the variant's total.
 */
async function ownedOnVariant(
  ctx: Pick<QueryCtx, "db">,
  variantId: Id<"selectorOptions">,
  cardIds: Iterable<string>,
): Promise<{ owned: number; ownedAll: number }> {
  let owned = 0;
  let ownedAll = 0;
  for (const raw of cardIds) {
    const card = await ctx.db.get(raw as Id<"cardChecklist">);
    if (!card || card.selectorOptionId !== variantId) continue;
    ownedAll += 1;
    if (!card.variationOfCardId) owned += 1;
  }
  return { owned, ownedAll };
}

// ───────────────────────────────────────────────────────────────────────────
// Queries
// ───────────────────────────────────────────────────────────────────────────

/**
 * The caller's whole collection at a glance, read off the tally on their Main
 * binder: one read whatever the collection's size. `exact` is false only for
 * a collector whose tally was never kept and who holds more than
 * `MAX_TALLY_RECOUNT_LINES` line items: the numbers are then a floor
 * ("5,000+"), until their next write counts them.
 */
export const summary = query({
  args: {},
  returns: v.object({
    copies: v.number(),
    lines: v.number(),
    distinctCards: v.number(),
    buildingSets: v.number(),
    exact: v.boolean(),
  }),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const main = await ctx.db
      .query("collectionContainers")
      .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId).eq("system", "main"))
      .first();
    const counted = main?.tally
      ? { tally: main.tally, exact: true }
      : await recountTally(ctx, ownerId);
    const building = await ctx.db
      .query("collectionBuildingSets")
      .withIndex("by_owner_and_set", (q) => q.eq("ownerId", ownerId))
      .take(MAX_BUILDING_SETS + 1);
    return {
      copies: counted.tally.copies,
      lines: counted.tally.lines,
      distinctCards: counted.tally.cards,
      buildingSets: building.length,
      exact: counted.exact,
    };
  },
});

/** One card the caller holds, as "Everything I own" lists it. */
export const ownedCardValidator = v.object({
  cardId: v.id("cardChecklist"),
  /** Physical copies, over every line of the card. */
  quantity: v.number(),
  /** Line items of the card. */
  lines: v.number(),
  /** When the card's newest line was last touched. */
  lastUpdated: v.number(),
});

/**
 * "Everything I own", one page at a time (`usePaginatedQuery`): every card
 * the caller holds, most recently touched first, however many there are.
 *
 * The pages walk LINE ITEMS (`by_owner_and_lastUpdated`, newest first), and a
 * card is listed exactly once, at its newest line: a line whose card has a
 * newer line is skipped, because that card was listed on this page or an
 * earlier one. Each listed card reads its own lines, so its counts are the
 * whole card's, whichever page its other lines fall on. A Have, an edit or a
 * fold stamps the line, so the card moves to the top and leaves the page it
 * was on. A page can list fewer cards than it read lines (or none); the
 * caller asks for more until it has enough.
 *
 * A page reads at most `MAX_OWNED_PAGE_LINES` lines whatever it is asked.
 */
export const ownedCards = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(ownedCardValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const asked = Math.floor(args.paginationOpts.numItems);
    const numItems = Math.max(1, Math.min(Number.isFinite(asked) ? asked : 1, MAX_OWNED_PAGE_LINES));
    const result = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_lastUpdated", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .paginate({ ...args.paginationOpts, numItems });
    const page: Array<typeof ownedCardValidator.type> = [];
    const seen = new Set<string>();
    for (const line of result.page) {
      if (seen.has(line.cardId)) continue;
      seen.add(line.cardId);
      const lines = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", line.cardId))
        .take(MAX_LINES_PER_CARD);
      if (lines.some((other) => newerLine(other, line))) continue;
      let quantity = 0;
      for (const other of lines) quantity += other.quantity;
      page.push({
        cardId: line.cardId,
        quantity,
        lines: lines.length,
        lastUpdated: line.lastUpdated,
      });
    }
    return { ...result, page };
  },
});

/**
 * Does `a` come before `b` in `ownedCards`' order? The index's: `lastUpdated`
 * descending, then `_creationTime` (every index ends in it) descending.
 */
function newerLine(a: CopyRow, b: CopyRow): boolean {
  if (a._id === b._id) return false;
  if (a.lastUpdated !== b.lastUpdated) return a.lastUpdated > b.lastUpdated;
  return a._creationTime > b._creationTime;
}

/** The caller's line items of one card, oldest first. Empty for a bad id. */
export const copiesOf = query({
  args: { cardId: v.string() },
  returns: v.array(copyValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const cardId = ctx.db.normalizeId("cardChecklist", args.cardId);
    if (!cardId) return [];
    const rows = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", cardId))
      .take(MAX_LINES_PER_CARD);
    return rows.map(copyOut);
  },
});

/** The caller's line items across one variant (a checklist's worth). */
export const copiesInVariant = query({
  args: { variantId: v.string() },
  returns: v.array(copyValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const variantId = ctx.db.normalizeId("selectorOptions", args.variantId);
    if (!variantId) return [];
    const setId = await findSetForSelectorOption(ctx, variantId);
    if (!setId) return [];
    const rows = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_set_variant", (q) =>
        q.eq("ownerId", ownerId).eq("setId", setId).eq("variantId", variantId),
      )
      .take(MAX_VARIANT_COPIES);
    return rows.map(copyOut);
  },
});

/**
 * "N of M" for one variant, two ways.
 *
 *   - `owned` / `total` (the default): regular cards only, the ones with no
 *     `variationOfCardId`. `total` is the row's `nonVariationCardCount`.
 *   - `ownedAll` / `totalAll`: every card, variations included. `totalAll`
 *     is the row's `cardCount`.
 *
 * Owned counts DISTINCT cards (three copies of #12 is one). A total is null
 * when the row was never counted and holds too many cards to count here.
 * Null for an id that is not a card-bearing row.
 */
export const variantCompletion = query({
  args: { variantId: v.string() },
  returns: v.union(
    v.object({
      owned: v.number(),
      total: v.union(v.number(), v.null()),
      ownedAll: v.number(),
      totalAll: v.union(v.number(), v.null()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const variantId = ctx.db.normalizeId("selectorOptions", args.variantId);
    if (!variantId) return null;
    const row = await ctx.db.get(variantId);
    if (
      !row ||
      (row.level !== "variantType" && row.level !== "insert" && row.level !== "parallel")
    ) {
      return null;
    }
    const setId = await findSetForSelectorOption(ctx, variantId);
    const copies = setId
      ? await ctx.db
          .query("collectionCopies")
          .withIndex("by_owner_set_variant", (q) =>
            q.eq("ownerId", ownerId).eq("setId", setId).eq("variantId", variantId),
          )
          .take(MAX_VARIANT_COPIES)
      : [];
    const counted = await ownedOnVariant(ctx, variantId, distinctCards(copies));
    const totals = await cardTotals(ctx, row, { left: COMPLETION_COUNT_BUDGET });
    return {
      owned: counted.owned,
      total: totals.base,
      ownedAll: counted.ownedAll,
      totalAll: totals.all,
    };
  },
});

/**
 * Owned counts for every variant of one set in one read, for a scoreboard:
 * per variant and across the set, regular cards (`owned`) and every card
 * (`ownedAll`). Totals come from `collectionCatalog.setSummary`.
 */
export const setCompletion = query({
  args: { setId: v.string() },
  returns: v.object({
    owned: v.number(),
    ownedAll: v.number(),
    variants: v.array(
      v.object({
        variantId: v.id("selectorOptions"),
        owned: v.number(),
        ownedAll: v.number(),
      }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const empty = { owned: 0, ownedAll: 0, variants: [], truncated: false };
    const setId = ctx.db.normalizeId("selectorOptions", args.setId);
    if (!setId) return empty;
    const rows = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_set_variant", (q) => q.eq("ownerId", ownerId).eq("setId", setId))
      .take(MAX_SUMMARY_LINES + 1);
    const truncated = rows.length > MAX_SUMMARY_LINES;
    const byVariant = new Map<string, { variantId: Id<"selectorOptions">; cards: Set<string> }>();
    for (const row of rows.slice(0, MAX_SUMMARY_LINES)) {
      const key = row.variantId as string;
      const entry = byVariant.get(key) ?? { variantId: row.variantId, cards: new Set<string>() };
      entry.cards.add(row.cardId as string);
      byVariant.set(key, entry);
    }
    let owned = 0;
    let ownedAll = 0;
    const variants = [];
    for (const entry of byVariant.values()) {
      const counted = await ownedOnVariant(ctx, entry.variantId, entry.cards);
      owned += counted.owned;
      ownedAll += counted.ownedAll;
      variants.push({ variantId: entry.variantId, ...counted });
    }
    return { owned, ownedAll, variants, truncated };
  },
});

/**
 * The sets the caller said they are building, most recently picked first.
 * `set` is null when the set row has gone (a deleted empty set sweeps these,
 * so this is defensive).
 */
export const buildingSets = query({
  args: {},
  returns: v.array(
    v.object({
      setId: v.id("selectorOptions"),
      set: v.union(setRefValidator, v.null()),
      lastUpdated: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const rows = await ctx.db
      .query("collectionBuildingSets")
      .withIndex("by_owner_and_set", (q) => q.eq("ownerId", ownerId))
      .take(MAX_BUILDING_SETS);
    const reader = new CatalogReader(ctx);
    const out = [];
    for (const row of [...rows].sort((a, b) => b.lastUpdated - a.lastUpdated)) {
      out.push({ setId: row.setId, set: await reader.setRef(row.setId), lastUpdated: row.lastUpdated });
    }
    return out;
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Mutations
// ───────────────────────────────────────────────────────────────────────────

/** "I have this one": one raw copy into Main, folding like any add. */
export const addHave = mutation({
  args: { cardId: v.id("cardChecklist"), acquiredOn: v.optional(v.string()) },
  returns: addResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const { result, delta } = await addOne(ctx, ownerId, args.cardId, haveDetails(args.acquiredOn));
    await moveTally(ctx, ownerId, delta);
    return result;
  },
});

/** `addHave` for up to `MAX_BATCH` cards at once (a pasted range). One result per card, in order. */
export const addHaves = mutation({
  args: { cardIds: v.array(v.id("cardChecklist")), acquiredOn: v.optional(v.string()) },
  returns: v.array(v.object({ cardId: v.id("cardChecklist"), ...addResultValidator.fields })),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    if (args.cardIds.length > MAX_BATCH) {
      refuse(COLLECTION_ERRORS.limit, `That's more than ${MAX_BATCH} cards at once. Add them in smaller bites.`);
    }
    const out = [];
    let delta = NO_CHANGE;
    for (const cardId of args.cardIds) {
      const added = await addOne(ctx, ownerId, cardId, haveDetails(args.acquiredOn));
      out.push({ cardId, ...added.result });
      delta = addTallies(delta, added.delta);
    }
    await moveTally(ctx, ownerId, delta);
    return out;
  },
});

/** Add a line item with full details. Folds into an identical row (see the header). */
export const addLineItem = mutation({
  args: { cardId: v.id("cardChecklist"), details: copyDetailsValidator },
  returns: addResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const { result, delta } = await addOne(ctx, ownerId, args.cardId, args.details);
    await moveTally(ctx, ownerId, delta);
    return result;
  },
});

/**
 * Replace a line item's details (absent optional fields are cleared; absent
 * `homeId` keeps the current home). Never folds into a sibling, so the undo
 * (`updateCopy` with `previous`) always lands on the same row.
 */
export const updateCopy = mutation({
  args: { copyId: v.id("collectionCopies"), details: copyDetailsValidator },
  returns: v.object({ previous: copyDetailsValidator }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownCopy(ctx, ownerId, args.copyId);
    const cleaned = cleanDetails(args.details);
    const homeId =
      args.details.homeId === undefined
        ? row.homeId
        : await resolveHome(ctx, ownerId, args.details.homeId);
    const previous = detailsOf(row);
    await ctx.db.replace(row._id, {
      ownerId: row.ownerId,
      cardId: row.cardId,
      variantId: row.variantId,
      setId: row.setId,
      ...cleaned,
      homeId,
      lastUpdated: Date.now(),
    });
    await moveTally(ctx, ownerId, { copies: cleaned.quantity - row.quantity, lines: 0, cards: 0 });
    return { previous };
  },
});

/** Remove a line item. Returns what `restoreCopy` needs to put it back. */
export const removeCopy = mutation({
  args: { copyId: v.id("collectionCopies") },
  returns: v.object({ removed: removedCopyValidator }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownCopy(ctx, ownerId, args.copyId);
    await ctx.db.delete(row._id);
    await moveTally(ctx, ownerId, {
      copies: -row.quantity,
      lines: -1,
      cards: (await stillHolds(ctx, ownerId, row.cardId)) ? 0 : -1,
    });
    return { removed: { cardId: row.cardId, details: detailsOf(row) } };
  },
});

/** Remove up to `MAX_BATCH` line items. All are checked before any is removed. */
export const removeCopies = mutation({
  args: { copyIds: v.array(v.id("collectionCopies")) },
  returns: v.object({ removed: v.array(removedCopyValidator) }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    if (args.copyIds.length > MAX_BATCH) {
      refuse(COLLECTION_ERRORS.limit, `That's more than ${MAX_BATCH} lines at once. Remove them in smaller bites.`);
    }
    const unique = [...new Set(args.copyIds)];
    const rows = [];
    for (const id of unique) rows.push(await ownCopy(ctx, ownerId, id));
    let copies = 0;
    for (const row of rows) {
      await ctx.db.delete(row._id);
      copies += row.quantity;
    }
    let cards = 0;
    for (const cardId of distinctCards(rows)) {
      if (!(await stillHolds(ctx, ownerId, cardId as Id<"cardChecklist">))) cards += 1;
    }
    await moveTally(ctx, ownerId, { copies: -copies, lines: -rows.length, cards: -cards });
    return { removed: rows.map((row) => ({ cardId: row.cardId, details: detailsOf(row) })) };
  },
});

/**
 * Put a removed line item back (the undo of `removeCopy`). Inserts a new row
 * with the same details; never folds, so a second undo-of-the-undo removes
 * exactly this row. Refuses when the card has left the catalog or the home
 * is no longer the caller's.
 */
export const restoreCopy = mutation({
  args: { cardId: v.id("cardChecklist"), details: copyDetailsValidator },
  returns: v.object({ copyId: v.id("collectionCopies") }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const cleaned = cleanDetails(args.details);
    const homeId = await resolveHome(ctx, ownerId, args.details.homeId);
    const place = await placeOf(ctx, args.cardId);
    const lines = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", args.cardId))
      .take(MAX_LINES_PER_CARD);
    if (lines.length >= MAX_LINES_PER_CARD) {
      refuse(COLLECTION_ERRORS.limit, `You already have ${MAX_LINES_PER_CARD} lines of this card. Stack some together first.`);
    }
    const copyId = await ctx.db.insert("collectionCopies", {
      ownerId,
      cardId: args.cardId,
      variantId: place.variantId,
      setId: place.setId,
      ...cleaned,
      homeId,
      lastUpdated: Date.now(),
    });
    await moveTally(ctx, ownerId, {
      copies: cleaned.quantity,
      lines: 1,
      cards: lines.length === 0 ? 1 : 0,
    });
    return { copyId };
  },
});

/**
 * Mark a set as one the caller is building, or stop. Idempotent: `changed`
 * is false when it already was (or wasn't).
 */
export const setBuilding = mutation({
  args: { setId: v.id("selectorOptions"), building: v.boolean() },
  returns: v.object({ changed: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const existing = await ctx.db
      .query("collectionBuildingSets")
      .withIndex("by_owner_and_set", (q) => q.eq("ownerId", ownerId).eq("setId", args.setId))
      .first();
    if (!args.building) {
      if (!existing) return { changed: false };
      await ctx.db.delete(existing._id);
      return { changed: true };
    }
    if (existing) return { changed: false };
    const set = await ctx.db.get(args.setId);
    if (!set || set.level !== "setName") {
      refuse(COLLECTION_ERRORS.notFound, "That set isn't in the catalog.");
    }
    const held = await ctx.db
      .query("collectionBuildingSets")
      .withIndex("by_owner_and_set", (q) => q.eq("ownerId", ownerId))
      .take(MAX_BUILDING_SETS);
    if (held.length >= MAX_BUILDING_SETS) {
      refuse(COLLECTION_ERRORS.limit, `You're building ${MAX_BUILDING_SETS} sets already. Finish or drop one first.`);
    }
    await ctx.db.insert("collectionBuildingSets", {
      ownerId,
      setId: args.setId,
      lastUpdated: Date.now(),
    });
    return { changed: true };
  },
});
