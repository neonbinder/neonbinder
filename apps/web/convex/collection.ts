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
 *
 * ## Binders and boxes (NEO-359)
 *
 * A copy has ONE home: Main, or one of the collector's binders or boxes
 * (`convex/collectionContainers.ts`). It is for sale exactly when its home is
 * a box; there is no for-sale flag. "Up for Trade" IS a flag on the copy
 * (`upForTrade`, stored only as `true`); the copy stays where it lives.
 * `slot` says where inside the home: a binder pocket (`page * 9 + pocket`,
 * one line item per pocket) or a box row (0 to 4, many per row). Every line
 * in a binder (Main included) has a pocket: a write that names none stacks
 * on an identical line already in that binder, else takes the first open
 * pocket (`arrivingPocket`, `firstOpenPocket`). Only a box holds unplaced lines.
 *
 * `moveCopy` is the only way a copy changes home. It folds into an identical
 * line at the destination (every detail, home, slot and trade flag), and part
 * of a stack splits off. Its result says where the cards came from, so the
 * undo is the inverse move with the same quantity. `placeCopy` is the same
 * move inside one home. `updateCopy` never changes a home and never folds.
 *
 * Every container keeps its own `count` (copies and lines), moved by every
 * write here in the same transaction (`moveCounts`), after the tally.
 *
 * ## Collection and inventory (NEO-364)
 *
 * The hard line: Collection = binders, Inventory = boxes. A copy whose home
 * is a binder (Main included) is on the collection side; one whose home is a
 * box (Unsorted included) is on the inventory side. The tally and the
 * building-set counts are COLLECTION ONLY, and every read that could serve
 * either side takes an explicit `side` (`copiesInVariant`,
 * `variantCompletion`, `setCompletion`); `ownedCards` and `summary` are the
 * collection's. A move (Sell / Take off sale) is the only crossing. The one
 * exception is Up for Trade, a flag on the copy read across both sides
 * (`tradeCopies`). The inventory's own reads and quick-count write live in
 * `convex/collectionInventory.ts`.
 *
 * Every write describes its row changes once (`CountChange[]`) and hands
 * them to `applyCopyChanges`, the single place the tally, the container
 * counts and the building-set counts move. No handler moves a number itself.
 */

import { ConvexError, v } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalAction, internalMutation, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireSignedIn } from "./auth";
import { findSetForSelectorOption } from "./lib/selectorAncestry";
import {
  CatalogReader,
  cardTotals,
  catalogCardWithPathValidator,
  setRefValidator,
} from "./lib/catalogView";
import { MAX_SET_VARIANTS, hiddenAsEmpty, walkSetVariants } from "./collectionCatalog";
import {
  collectionCopyConditionValidator,
  collectionCopyGradingValidator,
} from "./schema";
import type { collectionCountValidator, collectionTallyValidator } from "./schema";

type CopyRow = Doc<"collectionCopies">;
type ContainerRow = Doc<"collectionContainers">;

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
/** NEO-359 — binders and boxes one collector may make (system rows aside). */
export const MAX_CONTAINERS = 200;
/** NEO-359 — wants one collector may hold (`collectionWants`). */
export const MAX_WANTS = 2000;
/**
 * NEO-359 — lines a hand count of one container's `count` reads, when it was
 * never kept or drifted (and, for Main, cannot be derived from the tally).
 * Past it the container is left uncounted and reads as unknown.
 */
export const MAX_CONTAINER_RECOUNT_LINES = 5000;
/** NEO-359 — line items one `copiesInContainer` / `tradeCopies` page reads. */
export const MAX_CONTAINER_PAGE = 200;
/** NEO-359 — cards `copiesOfMany` takes per call (the card hunt). */
export const MAX_COPIES_OF_MANY = 50;
/**
 * NEO-359 — line items `copiesOfMany` reads per card. A line can carry ~8 KB
 * (a 2,000-character note at worst-case UTF-8, plus its other text), so 50
 * cards x 10 lines stays near 4 MB, well under a query's read-bytes limit.
 * The hunt asks "do I have it, and where": ten lines answer that; a card's
 * full list is `copiesOf`.
 */
export const MAX_COPIES_OF_MANY_LINES_PER_CARD = 10;
/** NEO-359 — cards one `cardsInSet` page returns. */
export const MAX_SET_CARDS_PAGE = 200;
/** NEO-359 — rows in a box: slots 0 to `BOX_ROWS - 1`. */
export const BOX_ROWS = 5;
/** NEO-359 — pockets on a binder page. */
export const POCKETS_PER_PAGE = 9;
/** NEO-359 — pages a binder's pockets run to: slots 0 to `9 * this - 1`. */
export const MAX_BINDER_PAGES = 1000;
/**
 * Main's pages. Main is where every card lands by default, so it runs far
 * past a binder's cap, but never unbounded: a pocket number past it would
 * make the binder view build that many pages.
 */
export const MAX_MAIN_PAGES = 100_000;
/**
 * Lines `firstOpenPocket` reads looking for a gap before it gives up and goes
 * past the last filled pocket, so a big Main never reads past a transaction.
 */
export const POCKET_SCAN = 256;

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
  /**
   * NEO-359 — a binder pocket (`page * 9 + pocket`) or a box row (0 to 4) in
   * the home. Absent: not placed.
   */
  slot: v.optional(v.number()),
  /** NEO-359 — on the Up for Trade shelf. Absent or false: not. */
  upForTrade: v.optional(v.boolean()),
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
  /** NEO-359 — where in its home; absent when not placed. */
  slot: v.optional(v.number()),
  /** NEO-359 — present (true) only when on the Up for Trade shelf. */
  upForTrade: v.optional(v.boolean()),
  lastUpdated: v.number(),
});

/**
 * NEO-359 — what a move (or a place) did. `copyId` is the line the moved
 * cards are now: the same row, a row split off, or the twin it folded into.
 * `from` is where they were, so the undo is `moveCopy({copyId, toHomeId:
 * from.homeId, quantity: from.quantity, slot: from.slot})`.
 */
export const moveResultValidator = v.object({
  copyId: v.id("collectionCopies"),
  folded: v.boolean(),
  split: v.boolean(),
  from: v.object({
    homeId: v.id("collectionContainers"),
    slot: v.optional(v.number()),
    quantity: v.number(),
  }),
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
export type StoredDetails = Omit<DetailsArg, "homeId" | "upForTrade"> & {
  homeId: Id<"collectionContainers">;
  upForTrade?: true;
};
type Count = typeof collectionCountValidator.type;

// ───────────────────────────────────────────────────────────────────────────
// Rules
// ───────────────────────────────────────────────────────────────────────────

export function refuse(code: string, message: string): never {
  throw new ConvexError({ code, message });
}

/** Trimmed text, or undefined for blank. Refuses text over `max`. */
export function cleanText(raw: string | undefined, max: number, what: string): string | undefined {
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
  if (raw.slot !== undefined && (!Number.isInteger(raw.slot) || raw.slot < 0)) {
    refuse(COLLECTION_ERRORS.invalid, "That pocket or row doesn't exist. Pick one from the page.");
  }
  return {
    quantity: raw.quantity,
    ...(raw.condition ? { condition: raw.condition } : {}),
    ...(grading ? { grading } : {}),
    ...(serialNumber ? { serialNumber } : {}),
    ...(raw.costCents !== undefined ? { costCents: raw.costCents } : {}),
    ...(acquiredOn ? { acquiredOn } : {}),
    ...(location ? { location } : {}),
    ...(notes ? { notes } : {}),
    ...(raw.slot !== undefined ? { slot: raw.slot } : {}),
    ...(raw.upForTrade === true ? { upForTrade: true as const } : {}),
  };
}

/**
 * The slots a home runs to: a box's `BOX_ROWS` rows, a binder's
 * `MAX_BINDER_PAGES` pages of pockets, Main's `MAX_MAIN_PAGES` (every card the
 * collector owns may land there, and tens of thousands is a real collection).
 */
export function slotLimit(home: Pick<ContainerRow, "kind" | "system">): number {
  if (home.kind === "box") return BOX_ROWS;
  return (home.system === "main" ? MAX_MAIN_PAGES : MAX_BINDER_PAGES) * POCKETS_PER_PAGE;
}

/**
 * NEO-359 — a slot checked against the home it is in (`slotLimit`). Whole
 * and non-negative is `cleanDetails`' check.
 */
export function checkSlot(home: Pick<ContainerRow, "kind" | "system">, slot: number | undefined): void {
  if (slot === undefined) return;
  const max = slotLimit(home);
  if (!Number.isInteger(slot) || slot < 0 || slot >= max) {
    refuse(
      COLLECTION_ERRORS.invalid,
      home.kind === "box"
        ? `A box has rows 1 to ${BOX_ROWS}. Pick one of those.`
        : "That pocket doesn't exist. Pick one from the page.",
    );
  }
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
    row.notes === next.notes &&
    row.slot === next.slot &&
    row.upForTrade === next.upForTrade
  );
}

/** A copy row's details, in the write shape (for `previous` and `removed`). */
export function detailsOf(row: CopyRow): StoredDetails {
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
    ...(row.slot !== undefined ? { slot: row.slot } : {}),
    ...(row.upForTrade === true ? { upForTrade: true as const } : {}),
  };
}

export function copyOut(row: CopyRow): typeof copyValidator.type {
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
export async function getOrCreateMain(
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
    // NEO-359 — no copy can be in a Main that did not exist: born counted.
    count: { copies: 0, lines: 0 },
    lastUpdated: Date.now(),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Sides (NEO-364): Collection = binders, Inventory = boxes
// ───────────────────────────────────────────────────────────────────────────

/**
 * NEO-364 — the two sides of a collector's cards. A copy is on the
 * collection side when its home is a binder (Main included) and on the
 * inventory side when its home is a box (Unsorted included). No collection
 * read, count or screen ever touches an inventory copy, and the reverse.
 */
export type Side = "collection" | "inventory";
export const sideValidator = v.union(v.literal("collection"), v.literal("inventory"));

/** The side a container's copies are on. */
export function sideOfContainer(row: Pick<ContainerRow, "kind">): Side {
  return row.kind === "box" ? "inventory" : "collection";
}

/**
 * NEO-364 — which side each home is on, read at most once per home per call
 * (one `get` each). A home that is gone or not the owner's is on no side:
 * its copies count nowhere, the same as a recount that walks the homes.
 */
export class HomeSides {
  private readonly known = new Map<string, Side | null>();
  constructor(
    private readonly ctx: Pick<QueryCtx, "db">,
    private readonly ownerId: string,
  ) {}

  async of(homeId: Id<"collectionContainers">): Promise<Side | null> {
    const cached = this.known.get(homeId);
    if (cached !== undefined) return cached;
    const row = await this.ctx.db.get(homeId);
    const side = row && row.ownerId === this.ownerId ? sideOfContainer(row) : null;
    this.known.set(homeId, side);
    return side;
  }

  async is(homeId: Id<"collectionContainers">, side: Side): Promise<boolean> {
    return (await this.of(homeId)) === side;
  }

  /** Only the rows whose home is on `side`, order kept. */
  async keep<T extends { homeId: Id<"collectionContainers"> }>(rows: ReadonlyArray<T>, side: Side): Promise<T[]> {
    const out: T[] = [];
    for (const row of rows) if (await this.is(row.homeId, side)) out.push(row);
    return out;
  }
}

/** System rows a collector can have: Main, Unsorted, the Want List, Up for Trade. */
export const MAX_SYSTEM_CONTAINERS = 4;

/**
 * NEO-364 — the owner's collection HOMES (Main and their binders; never a
 * box, never the Want List or Up for Trade, which hold no copies), oldest
 * first. One bounded read.
 */
async function collectionHomes(ctx: Pick<QueryCtx, "db">, ownerId: string): Promise<ContainerRow[]> {
  const rows = await ctx.db
    .query("collectionContainers")
    .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId))
    .take(MAX_CONTAINERS + MAX_SYSTEM_CONTAINERS);
  return rows.filter(
    (row) => sideOfContainer(row) === "collection" && row.system !== "want" && row.system !== "trade",
  );
}

type Tally = typeof collectionTallyValidator.type;

/**
 * NEO-364 — Main's tally when it is a kept, collection-only one. A tally
 * from before NEO-364 (no `tallyScope`) counted boxes too and reads as not
 * kept: recounted on the next write, counted by hand on a read until then.
 */
function keptTally(main: Pick<ContainerRow, "tally" | "tallyScope"> | null | undefined): Tally | undefined {
  return main?.tallyScope === "collection" ? main.tally : undefined;
}

/**
 * NEO-364 — a building set's `cards` when it is a kept, collection-only
 * count; undefined (not counted) otherwise, a NEO-359 all-homes count included.
 */
function keptCards(row: Pick<Doc<"collectionBuildingSets">, "cards" | "tallyScope">): number | undefined {
  return row.tallyScope === "collection" ? row.cards : undefined;
}

/**
 * The caller's tally counted by hand: the lines in their collection homes
 * (Main and binders, never a box), at most `MAX_TALLY_RECOUNT_LINES` of them
 * over every home. `exact` is false when there were more: the numbers are
 * then a floor, never the answer.
 */
async function recountTally(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
): Promise<{ tally: Tally; exact: boolean; rows: CopyRow[] }> {
  const homes = await collectionHomes(ctx, ownerId);
  const rows: CopyRow[] = [];
  let exact = true;
  for (const home of homes) {
    const left = MAX_TALLY_RECOUNT_LINES - rows.length;
    const lines = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", home._id))
      .take(left + 1);
    if (lines.length > left) {
      rows.push(...lines.slice(0, left));
      exact = false;
      break;
    }
    rows.push(...lines);
  }
  let copies = 0;
  for (const row of rows) copies += row.quantity;
  return {
    tally: { copies, lines: rows.length, cards: distinctCards(rows).size },
    exact,
    rows,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Cards on each set build (NEO-359): "Everything else" = tally.cards - these
// ───────────────────────────────────────────────────────────────────────────

/** Lines one hand count of a building set's `cards` reads. */
export const MAX_BUILDING_CARDS_RECOUNT_LINES = MAX_SUMMARY_LINES;

/**
 * Distinct cards the owner holds in `setId` in a collection home (lines
 * naming the set whose home is a binder; NEO-364: never a box), counted by
 * hand from at most `MAX_BUILDING_CARDS_RECOUNT_LINES` lines and at most
 * `budget.left` reads, which it spends. Box lines are read and skipped, so
 * they spend the budget too. Null when it could not finish: the count is
 * then unknown, never a floor.
 */
export async function countSetCards(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  setId: Id<"selectorOptions">,
  budget: { left: number },
  sides: HomeSides = new HomeSides(ctx, ownerId),
): Promise<number | null> {
  const limit = Math.min(budget.left, MAX_BUILDING_CARDS_RECOUNT_LINES);
  if (limit <= 0) return null;
  const rows = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_set_variant", (q) => q.eq("ownerId", ownerId).eq("setId", setId))
    .take(limit + 1);
  budget.left -= Math.min(rows.length, limit);
  if (rows.length > limit) return null;
  return distinctCards(await sides.keep(rows, "collection")).size;
}

/** A whole card gained (+1) or lost (-1) in a set, as one write saw it. */
export type SetCardsChange = { setId: Id<"selectorOptions">; cards: number };

/**
 * Move the `cards` on the owner's building-set rows by `changes`, AFTER the
 * writes, in the same transaction. A set the owner is not building has no
 * row and nothing to keep. A row whose count is not kept (absent, from before
 * NEO-364, or would go below zero: drift) is counted by hand instead and
 * stamped collection-only, and left uncounted when that cannot finish.
 * Only `applyCopyChanges` calls it.
 */
async function moveBuildingCards(
  ctx: MutationCtx,
  ownerId: string,
  changes: ReadonlyArray<SetCardsChange>,
  sides: HomeSides,
): Promise<void> {
  const bySet = new Map<Id<"selectorOptions">, number>();
  for (const { setId, cards } of changes) bySet.set(setId, (bySet.get(setId) ?? 0) + cards);
  for (const [setId, delta] of bySet) {
    if (delta === 0) continue;
    const row = await ctx.db
      .query("collectionBuildingSets")
      .withIndex("by_owner_and_set", (q) => q.eq("ownerId", ownerId).eq("setId", setId))
      .first();
    if (!row) continue;
    const kept = keptCards(row);
    if (kept !== undefined) {
      const next = kept + delta;
      if (next >= 0) {
        await ctx.db.patch(row._id, { cards: next });
        continue;
      }
      console.warn(
        JSON.stringify({ event: "collection_building_cards_drift", stored: kept, delta }),
      );
    }
    await recountBuildingRow(ctx, ownerId, row, sides);
  }
}

/** Count one building-set row by hand and store it, stamped; unknown when it cannot finish. */
async function recountBuildingRow(
  ctx: MutationCtx,
  ownerId: string,
  row: Doc<"collectionBuildingSets">,
  sides: HomeSides,
): Promise<number | null> {
  const counted = await countSetCards(
    ctx,
    ownerId,
    row.setId,
    { left: MAX_BUILDING_CARDS_RECOUNT_LINES },
    sides,
  );
  await ctx.db.patch(
    row._id,
    counted === null
      ? { cards: undefined, tallyScope: undefined }
      : { cards: counted, tallyScope: "collection" },
  );
  return counted;
}

/**
 * The catalog side (`setShapeMove`): copies of `ownerId` moved into or out
 * of each of `setIds`, so the owner's building-set count for each is no
 * longer known. Clears it (absent = count by hand); a set the owner is not
 * building has nothing to clear.
 */
export async function forgetBuildingCards(
  ctx: MutationCtx,
  pairs: Iterable<{ ownerId: string; setId: Id<"selectorOptions"> }>,
): Promise<void> {
  const seen = new Set<string>();
  for (const { ownerId, setId } of pairs) {
    const key = `${ownerId}|${setId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const row = await ctx.db
      .query("collectionBuildingSets")
      .withIndex("by_owner_and_set", (q) => q.eq("ownerId", ownerId).eq("setId", setId))
      .first();
    if (row && row.cards !== undefined) await ctx.db.patch(row._id, { cards: undefined });
  }
}

/**
 * Distinct cards the owner holds in a collection home on any of `building`
 * (their set builds): each row's kept `cards`, or a hand count for a row
 * without one. With `rows` (every one of the owner's collection lines, from
 * a tally recount) it is counted off those instead, with no reads. `exact`
 * is false when a hand count could not finish.
 */
async function cardsOnBuilds(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  building: ReadonlyArray<Doc<"collectionBuildingSets">>,
  rows: CopyRow[] | null,
): Promise<{ cards: number; exact: boolean }> {
  if (rows) {
    const bySet = new Map<string, Set<string>>();
    for (const row of rows) {
      const set = bySet.get(row.setId) ?? new Set<string>();
      set.add(row.cardId);
      bySet.set(row.setId, set);
    }
    let cards = 0;
    for (const b of building) cards += bySet.get(b.setId)?.size ?? 0;
    return { cards, exact: true };
  }
  const budget = { left: MAX_BUILDING_CARDS_RECOUNT_LINES };
  const sides = new HomeSides(ctx, ownerId);
  let cards = 0;
  let exact = true;
  for (const b of building) {
    const kept = keptCards(b);
    if (kept !== undefined) {
      cards += kept;
      continue;
    }
    const counted = await countSetCards(ctx, ownerId, b.setId, budget, sides);
    if (counted === null) exact = false;
    else cards += counted;
  }
  return { cards, exact };
}

/**
 * Move the caller's tally by `delta`, AFTER the write it describes, in the
 * same transaction. The tally lives on Main (see the schema); a collector
 * without a kept one yet (absent, or from before NEO-364), or one whose tally
 * would go below zero (drift), is counted by hand instead and stamped
 * collection-only, and left uncounted when even that is too big to finish.
 * Only `applyCopyChanges` calls it.
 */
async function moveTally(ctx: MutationCtx, ownerId: string, delta: Tally): Promise<void> {
  if (delta.copies === 0 && delta.lines === 0 && delta.cards === 0) return;
  const mainId = await getOrCreateMain(ctx, ownerId);
  const main = await ctx.db.get(mainId);
  const stored = keptTally(main);
  if (stored) {
    const next = { copies: stored.copies + delta.copies, lines: stored.lines + delta.lines, cards: stored.cards + delta.cards };
    if (next.copies >= 0 && next.lines >= 0 && next.cards >= 0) {
      await ctx.db.patch(mainId, { tally: next });
      return;
    }
    console.warn(JSON.stringify({ event: "collection_tally_drift", stored, delta }));
  }
  const counted = await recountTally(ctx, ownerId);
  await ctx.db.patch(
    mainId,
    counted.exact
      ? { tally: counted.tally, tallyScope: "collection" }
      : { tally: undefined, tallyScope: undefined },
  );
}

/**
 * Collection lines the owner holds of `cardId` right now (this transaction's
 * writes included), at most `MAX_LINES_PER_CARD + 1` read.
 */
async function collectionLinesOf(
  ctx: MutationCtx,
  ownerId: string,
  cardId: Id<"cardChecklist">,
  sides: HomeSides,
): Promise<number> {
  const lines = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", cardId))
    .take(MAX_LINES_PER_CARD + 1);
  return (await sides.keep(lines, "collection")).length;
}

/**
 * NEO-364 — the ONE place a copy write moves the owner's numbers: every
 * handler describes its row writes as `CountChange`s (the row before and
 * after, with its card and set) and calls this once, AFTER the writes, in
 * the same transaction. From those changes and the side of each home it
 * derives, never per handler:
 *
 *   1. the tally (collection side only: copies and lines of rows in a
 *      binder home; a distinct card gained when a card's first collection
 *      line arrives, lost when its last one goes),
 *   2. every container's own count (`moveCounts`, both sides, Trade too),
 *   3. the building-set `cards` (the same gained/lost cards, by set).
 *
 * A card's collection presence before the write is its collection lines now
 * minus the net collection lines the changes added, so a card is read only
 * when its net collection lines moved (an add, a delete, a binder/box move;
 * never a quantity edit, a trade flag, or a write wholly inside boxes).
 */
export async function applyCopyChanges(
  ctx: MutationCtx,
  ownerId: string,
  changes: ReadonlyArray<CountChange>,
): Promise<void> {
  const sides = new HomeSides(ctx, ownerId);
  let copies = 0;
  let lines = 0;
  const perCard = new Map<string, { cardId: Id<"cardChecklist">; setId: Id<"selectorOptions">; lines: number }>();
  for (const change of changes) {
    for (const [row, sign] of [
      [change.before, -1],
      [change.after, 1],
    ] as const) {
      if (!row || !(await sides.is(row.homeId, "collection"))) continue;
      copies += sign * row.quantity;
      lines += sign;
      const entry = perCard.get(change.cardId) ?? { cardId: change.cardId, setId: change.setId, lines: 0 };
      entry.lines += sign;
      perCard.set(change.cardId, entry);
    }
  }
  let cards = 0;
  const setCards: SetCardsChange[] = [];
  for (const entry of perCard.values()) {
    if (entry.lines === 0) continue;
    const now = await collectionLinesOf(ctx, ownerId, entry.cardId, sides);
    const before = now - entry.lines;
    const delta = (now > 0 ? 1 : 0) - (before > 0 ? 1 : 0);
    if (delta === 0) continue;
    cards += delta;
    setCards.push({ setId: entry.setId, cards: delta });
  }
  await moveTally(ctx, ownerId, { copies, lines, cards });
  await moveCounts(ctx, ownerId, changes);
  await moveBuildingCards(ctx, ownerId, setCards, sides);
}

/**
 * The home a write names, checked: the caller's own container, and a HOME
 * (Main, or a binder or box the collector made). The Want List and the Up for
 * Trade shelf are never homes (NEO-359), nor is a smart binder (it fills
 * itself from its rule). Absent means Main.
 */
export async function resolveHome(
  ctx: MutationCtx,
  ownerId: string,
  homeId: Id<"collectionContainers"> | undefined,
): Promise<ContainerRow> {
  const id = homeId === undefined ? await getOrCreateMain(ctx, ownerId) : homeId;
  const home = await ctx.db.get(id);
  if (!home || home.ownerId !== ownerId) {
    refuse(COLLECTION_ERRORS.notFound, "That binder or box isn't in your collection.");
  }
  if (home.system === "want") {
    refuse(COLLECTION_ERRORS.invalid, "The Want List holds cards you're looking for, not cards you have. Pick a binder or a box.");
  }
  if (home.system === "trade") {
    refuse(COLLECTION_ERRORS.invalid, "Up for Trade isn't a place, it's a flag. Keep the card in a binder or a box and turn on Up for Trade.");
  }
  if (home.rule !== undefined) {
    refuse(COLLECTION_ERRORS.invalid, "A smart binder fills itself. Pick a binder or a box to keep the card in.");
  }
  return home;
}

/**
 * NEO-359 — a binder pocket holds one line item. Refuses when another line
 * (not `except`, the row being moved or the twin it folds into) sits in
 * `slot` of `home`. A box row holds many, so a box is never checked.
 */
async function assertPocketFree(
  ctx: MutationCtx,
  ownerId: string,
  home: Pick<ContainerRow, "_id" | "kind">,
  slot: number | undefined,
  except: ReadonlyArray<Id<"collectionCopies">>,
): Promise<void> {
  if (slot === undefined || home.kind !== "binder") return;
  const lines = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_home_slot", (q) =>
      q.eq("ownerId", ownerId).eq("homeId", home._id).eq("slot", slot),
    )
    .take(except.length + 1);
  if (lines.some((line) => !except.includes(line._id))) {
    refuse(COLLECTION_ERRORS.invalid, "That pocket already holds a card. Pick an empty pocket, or move that card first.");
  }
}

/** Is `slot` of a binder `home` free of every line but `except`? (Restore's soft check.) */
async function pocketIsFree(
  ctx: MutationCtx,
  ownerId: string,
  home: Pick<ContainerRow, "_id" | "kind">,
  slot: number | undefined,
): Promise<boolean> {
  if (slot === undefined || home.kind !== "binder") return true;
  const line = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_home_slot", (q) =>
      q.eq("ownerId", ownerId).eq("homeId", home._id).eq("slot", slot),
    )
    .first();
  return line === null;
}

/** The refusal when a binder has no open pocket left. */
export const BINDER_FULL = "That binder is full. Start another binder for the rest.";

/**
 * A home whose every line sits in a pocket: a binder, Main included. A box
 * has rows (a card may wait outside them) and a smart binder holds nothing.
 * There is no "in the binder but not in a pocket".
 */
export function keepsPockets(home: Pick<ContainerRow, "kind" | "system" | "rule">): boolean {
  return home.kind === "binder" && home.rule === undefined && home.system !== "want" && home.system !== "trade";
}

/**
 * The first pocket of binder `homeId` no line holds. Starts at the binder's
 * `openPocket` hint, reads its pocketed lines in slot order up to the first
 * gap, and raises the hint past the pocket it returns (the caller fills it,
 * or refuses and rolls the hint back with it). Past `POCKET_SCAN` lines with
 * no gap it takes the pocket after the last filled one instead (one read),
 * skipping any gap further on: the hint is never truth. Refuses a full
 * binder (`slotLimit`).
 */
export async function firstOpenPocket(
  ctx: MutationCtx,
  ownerId: string,
  homeId: Id<"collectionContainers">,
): Promise<number> {
  const home = await ctx.db.get(homeId);
  let next = home?.openPocket ?? 0;
  const lines = ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", homeId).gte("slot", next));
  let read = 0;
  let gap = false;
  for await (const line of lines) {
    const slot = line.slot ?? -1;
    if (slot > next) {
      gap = true;
      break;
    }
    if (slot === next) next += 1;
    if (++read >= POCKET_SCAN) break;
  }
  if (!gap && read >= POCKET_SCAN) {
    const last = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", homeId))
      .order("desc")
      .first();
    next = Math.max(next, (last?.slot ?? -1) + 1);
  }
  if (home && next >= slotLimit(home)) {
    refuse(COLLECTION_ERRORS.limit, BINDER_FULL);
  }
  if (home && home.openPocket !== next + 1) await ctx.db.patch(homeId, { openPocket: next + 1 });
  return next;
}

/** A pocket of `homeId` emptied: its `openPocket` hint comes down to it. */
export async function pocketEmptied(
  ctx: MutationCtx,
  homeId: Id<"collectionContainers">,
  slot: number | undefined,
): Promise<void> {
  if (slot === undefined) return;
  const home = await ctx.db.get(homeId);
  if (home?.openPocket !== undefined && slot < home.openPocket) {
    await ctx.db.patch(homeId, { openPocket: slot });
  }
}

/**
 * Where a line arriving in binder `home` with no pocket named goes: the
 * pocket of an identical line already there, so an add or a move stacks onto
 * it as it always has (and refuses past `MAX_COPY_QUANTITY` as it always
 * has), else the first open pocket. `lines` are the card's lines; `except`
 * the ones leaving.
 */
export async function arrivingPocket(
  ctx: MutationCtx,
  ownerId: string,
  home: Pick<ContainerRow, "_id">,
  lines: readonly CopyRow[],
  next: StoredDetails,
  except: ReadonlyArray<Id<"collectionCopies">> = [],
): Promise<number> {
  const twin = lines.find(
    (row) =>
      !except.includes(row._id) &&
      row.homeId === home._id &&
      row.slot !== undefined &&
      foldsInto(detailsOf(row), { ...next, homeId: home._id, slot: row.slot }),
  );
  return twin?.slot ?? (await firstOpenPocket(ctx, ownerId, home._id));
}

/** Where a card files: its variant row and that row's set. Refuses a gone card. */
export async function placeOf(
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

// ───────────────────────────────────────────────────────────────────────────
// Container counts (NEO-359)
// ───────────────────────────────────────────────────────────────────────────

/** What a copy row contributes to the counts: its home, its quantity, its trade flag. */
export type Counted = {
  homeId: Id<"collectionContainers">;
  quantity: number;
  upForTrade?: true;
};

/**
 * One row's write, as the counts see it: the row before (null for an
 * insert) and after (null for a delete), and the card and set the row is of.
 * Every write path describes itself this way and `applyCopyChanges` turns it
 * into the tally, the container counts and the building-set counts, so a
 * split, a fold, a move, a binder/box crossing and a trade flag are all
 * handled in one place.
 */
export type CountChange = {
  cardId: Id<"cardChecklist">;
  setId: Id<"selectorOptions">;
  before: Counted | null;
  after: Counted | null;
};

/** A `CountChange` for one of `row`'s writes. */
export function changeOf(
  row: Pick<CopyRow, "cardId" | "setId">,
  before: Counted | null,
  after: Counted | null,
): CountChange {
  return { cardId: row.cardId, setId: row.setId, before, after };
}

const TRADE_KEY = "trade";

export function counted(row: Pick<CopyRow, "homeId" | "quantity" | "upForTrade">): Counted {
  return {
    homeId: row.homeId,
    quantity: row.quantity,
    ...(row.upForTrade === true ? { upForTrade: true as const } : {}),
  };
}

/** Per-container deltas from a list of row changes; zero deltas dropped. */
export function countDeltas(changes: ReadonlyArray<CountChange>): Map<string, Count> {
  const out = new Map<string, Count>();
  const bump = (key: string, copies: number, lines: number) => {
    const prev = out.get(key) ?? { copies: 0, lines: 0 };
    out.set(key, { copies: prev.copies + copies, lines: prev.lines + lines });
  };
  for (const { before, after } of changes) {
    if (before) {
      bump(before.homeId, -before.quantity, -1);
      if (before.upForTrade) bump(TRADE_KEY, -before.quantity, -1);
    }
    if (after) {
      bump(after.homeId, after.quantity, 1);
      if (after.upForTrade) bump(TRADE_KEY, after.quantity, 1);
    }
  }
  for (const [key, delta] of [...out]) {
    if (delta.copies === 0 && delta.lines === 0) out.delete(key);
  }
  return out;
}

/** The copies and lines among `rows`. */
function sumRows(rows: ReadonlyArray<Pick<CopyRow, "quantity">>): Count {
  let copies = 0;
  for (const row of rows) copies += row.quantity;
  return { copies, lines: rows.length };
}

/**
 * A container's count from the rows themselves, for a container whose stored
 * count is absent or drifted. Reads at most `budget.left` documents and
 * spends them; null when it could not finish (the count is then unknown,
 * never a floor). Main first tries the cheap derivation: the owner's tally
 * minus every collector-made BINDER's count (NEO-364: the tally counts no
 * box, so no box is subtracted), when the tally is kept and every one of
 * those binders is counted (exact for every NEO-358 collector, no backfill).
 */
export async function countContainer(
  ctx: Pick<QueryCtx, "db">,
  row: Pick<ContainerRow, "_id" | "ownerId" | "system" | "tally" | "tallyScope">,
  budget: { left: number },
): Promise<Count | null> {
  const ownerId = row.ownerId;
  if (row.system === "want") {
    if (budget.left <= 0) return null;
    const wants = await ctx.db
      .query("collectionWants")
      .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId))
      .take(Math.min(budget.left, MAX_WANTS) + 1);
    budget.left -= wants.length;
    if (wants.length > MAX_WANTS || budget.left < 0) return null;
    return { copies: wants.length, lines: wants.length };
  }
  if (row.system === "trade") {
    if (budget.left <= 0) return null;
    const rows = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_trade", (q) => q.eq("ownerId", ownerId).eq("upForTrade", true))
      .take(budget.left + 1);
    budget.left -= rows.length;
    if (budget.left < 0) return null;
    return sumRows(rows);
  }
  const tally = row.system === "main" ? keptTally(row) : undefined;
  if (tally) {
    const own = await ctx.db
      .query("collectionContainers")
      .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId).eq("system", undefined))
      .take(MAX_CONTAINERS + 1);
    const binders = own.filter((c) => sideOfContainer(c) === "collection");
    if (own.length <= MAX_CONTAINERS && binders.every((c) => c.count !== undefined)) {
      let copies = tally.copies;
      let lines = tally.lines;
      for (const c of binders) {
        copies -= c.count!.copies;
        lines -= c.count!.lines;
      }
      if (copies >= 0 && lines >= 0) return { copies, lines };
    }
  }
  if (budget.left <= 0) return null;
  const rows = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", row._id))
    .take(budget.left + 1);
  budget.left -= rows.length;
  if (budget.left < 0) return null;
  return sumRows(rows);
}

/**
 * Move one container's stored count by `delta`, AFTER the write it describes.
 * Absent (never kept) or drifted (would go below zero): counted by hand
 * instead (`countContainer`), and left uncounted when that cannot finish.
 */
async function moveContainerCount(
  ctx: MutationCtx,
  row: ContainerRow,
  delta: Count,
): Promise<void> {
  if (row.count) {
    const next = { copies: row.count.copies + delta.copies, lines: row.count.lines + delta.lines };
    if (next.copies >= 0 && next.lines >= 0) {
      await ctx.db.patch(row._id, { count: next });
      return;
    }
    console.warn(
      JSON.stringify({ event: "collection_container_count_drift", stored: row.count, delta }),
    );
  }
  const recount = await countContainer(ctx, row, { left: MAX_CONTAINER_RECOUNT_LINES });
  await ctx.db.patch(row._id, { count: recount ?? undefined });
}

/**
 * Move one of the caller's system rows' counts by `delta` (the Want List and
 * Up for Trade, from outside the home path), if that row exists yet
 * (`ensureSystem` makes them, counted). A collector without one has nothing
 * to keep.
 */
export async function moveSystemCount(
  ctx: MutationCtx,
  ownerId: string,
  system: NonNullable<ContainerRow["system"]>,
  delta: Count,
): Promise<void> {
  if (delta.copies === 0 && delta.lines === 0) return;
  const row = await ctx.db
    .query("collectionContainers")
    .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId).eq("system", system))
    .first();
  if (row) await moveContainerCount(ctx, row, delta);
}

/**
 * Move every container count `changes` touches, in the same transaction and
 * AFTER the writes (and after `moveTally`, which Main's derivation reads).
 * Collector-made homes first, Main last, so Main's derivation sees their new
 * counts. Called by `applyCopyChanges` and nothing else.
 */
async function moveCounts(
  ctx: MutationCtx,
  ownerId: string,
  changes: ReadonlyArray<CountChange>,
): Promise<void> {
  const deltas = countDeltas(changes);
  let main: { id: Id<"collectionContainers">; delta: Count } | null = null;
  for (const [key, delta] of deltas) {
    if (key === TRADE_KEY) {
      await moveSystemCount(ctx, ownerId, "trade", delta);
      continue;
    }
    const id = key as Id<"collectionContainers">;
    const row = await ctx.db.get(id);
    if (!row || row.ownerId !== ownerId) continue;
    if (row.system === "main") {
      main = { id, delta };
      continue;
    }
    await moveContainerCount(ctx, row, delta);
  }
  if (main) {
    const row = await ctx.db.get(main.id);
    if (row) await moveContainerCount(ctx, row, main.delta);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Adds and moves
// ───────────────────────────────────────────────────────────────────────────

/**
 * Add one line item, folding when the rule allows. Returns the row change;
 * the caller applies every add's change once (`applyCopyChanges`), after all
 * its adds.
 */
async function addOne(
  ctx: MutationCtx,
  ownerId: string,
  cardId: Id<"cardChecklist">,
  raw: DetailsArg,
): Promise<{
  result: typeof addResultValidator.type;
  change: CountChange;
}> {
  const cleaned = cleanDetails(raw);
  const home = await resolveHome(ctx, ownerId, raw.homeId);
  checkSlot(home, cleaned.slot);
  const place = await placeOf(ctx, cardId);
  const lines = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", cardId))
    .take(MAX_LINES_PER_CARD + 1);
  if (cleaned.slot === undefined && keepsPockets(home)) {
    cleaned.slot = await arrivingPocket(ctx, ownerId, home, lines, { ...cleaned, homeId: home._id });
  }
  const next: StoredDetails = { ...cleaned, homeId: home._id };
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
      change: changeOf(into, counted(into), counted({ ...into, quantity })),
    };
  }
  if (lines.length >= MAX_LINES_PER_CARD) {
    refuse(COLLECTION_ERRORS.limit, `You already have ${MAX_LINES_PER_CARD} lines of this card. Stack some together first.`);
  }
  await assertPocketFree(ctx, ownerId, home, next.slot, []);
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
    change: changeOf({ cardId, setId: place.setId }, null, counted(next)),
  };
}

/**
 * NEO-359 — move `quantity` of a line item (all of it by default) to
 * `toHomeId` at `slot` (absent: a binder's first open pocket, or its own
 * pocket when it stays in the same binder; elsewhere not placed). The moved cards fold into an
 * identical line there (every detail, the home, the slot and the trade flag);
 * part of a stack splits off and the source keeps the rest. Moving cards to
 * where they already are (same home, same slot) changes nothing. Refuses the
 * Want List, Up for Trade, a smart binder, and a binder pocket another line
 * holds. Returns the result and applies the numbers itself
 * (`applyCopyChanges`): NEO-364, a binder-to-box move (Sell) leaves the tally,
 * a box-to-binder one (Take off sale) joins it.
 */
export async function moveCopyCore(
  ctx: MutationCtx,
  ownerId: string,
  row: CopyRow,
  toHomeId: Id<"collectionContainers">,
  quantityArg: number | undefined,
  slot: number | undefined,
): Promise<typeof moveResultValidator.type> {
  const quantity = quantityArg ?? row.quantity;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > row.quantity) {
    refuse(
      COLLECTION_ERRORS.invalid,
      row.quantity === 1
        ? "There's only one of these to move."
        : `Move a whole number of cards from 1 to ${row.quantity}.`,
    );
  }
  if (slot !== undefined && (!Number.isInteger(slot) || slot < 0)) {
    refuse(COLLECTION_ERRORS.invalid, "That pocket or row doesn't exist. Pick one from the page.");
  }
  const from = {
    homeId: row.homeId,
    ...(row.slot !== undefined ? { slot: row.slot } : {}),
    quantity,
  };
  const home = toHomeId === row.homeId ? await ctx.db.get(toHomeId) : await resolveHome(ctx, ownerId, toHomeId);
  if (!home) {
    refuse(COLLECTION_ERRORS.notFound, "That binder or box isn't in your collection.");
  }
  checkSlot(home, slot);
  const lines = await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", row.cardId))
    .take(MAX_LINES_PER_CARD + 1);
  const rest: StoredDetails = { ...detailsOf(row), quantity, homeId: home._id };
  delete rest.slot;
  if (slot === undefined && keepsPockets(home)) {
    // Every card in a binder sits in a pocket: staying in the same binder
    // keeps its own; arriving stacks on a twin or takes the first open one.
    slot =
      toHomeId === row.homeId && row.slot !== undefined
        ? row.slot
        : await arrivingPocket(ctx, ownerId, home, lines, rest, [row._id]);
  }
  if (toHomeId === row.homeId && slot === row.slot) {
    return { copyId: row._id, folded: false, split: false, from };
  }
  const next: StoredDetails = { ...rest, ...(slot !== undefined ? { slot } : {}) };
  const into = lines.find((other) => other._id !== row._id && foldsInto(detailsOf(other), next));
  const whole = quantity === row.quantity;
  await assertPocketFree(ctx, ownerId, home, slot, [row._id, ...(into ? [into._id] : [])]);
  const now = Date.now();
  const changes: CountChange[] = [];
  let copyId: Id<"collectionCopies">;
  if (into) {
    const total = into.quantity + quantity;
    if (total > MAX_COPY_QUANTITY) {
      refuse(COLLECTION_ERRORS.limit, `That stack would pass ${MAX_COPY_QUANTITY} copies. Move fewer, or start a new line.`);
    }
    await ctx.db.patch(into._id, { quantity: total, lastUpdated: now });
    changes.push(changeOf(into, counted(into), counted({ ...into, quantity: total })));
    if (whole) {
      await ctx.db.delete(row._id);
      changes.push(changeOf(row, counted(row), null));
    } else {
      await ctx.db.patch(row._id, { quantity: row.quantity - quantity, lastUpdated: now });
      changes.push(changeOf(row, counted(row), counted({ ...row, quantity: row.quantity - quantity })));
    }
    copyId = into._id;
  } else if (whole) {
    await ctx.db.patch(row._id, { homeId: home._id, slot, lastUpdated: now });
    changes.push(changeOf(row, counted(row), counted({ ...row, homeId: home._id })));
    copyId = row._id;
  } else {
    if (lines.length >= MAX_LINES_PER_CARD) {
      refuse(COLLECTION_ERRORS.limit, `You already have ${MAX_LINES_PER_CARD} lines of this card. Stack some together first.`);
    }
    await ctx.db.patch(row._id, { quantity: row.quantity - quantity, lastUpdated: now });
    changes.push(changeOf(row, counted(row), counted({ ...row, quantity: row.quantity - quantity })));
    copyId = await ctx.db.insert("collectionCopies", {
      ownerId,
      cardId: row.cardId,
      variantId: row.variantId,
      setId: row.setId,
      ...next,
      lastUpdated: now,
    });
    changes.push(changeOf(row, null, counted(next)));
  }
  // The whole line left its pocket (a part leaves the rest behind in it).
  if (whole) await pocketEmptied(ctx, row.homeId, row.slot);
  await applyCopyChanges(ctx, ownerId, changes);
  return { copyId, folded: into !== undefined, split: !whole, from };
}

/** A fresh copy of a card: one raw card, in `homeId` when given, else Main. */
function haveDetails(
  acquiredOn: string | undefined,
  homeId?: Id<"collectionContainers">,
): DetailsArg {
  return { quantity: 1, ...(acquiredOn ? { acquiredOn } : {}), ...(homeId ? { homeId } : {}) };
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
 * binder: one read whatever the collection's size. NEO-364: the COLLECTION
 * only (binder homes, Main included); a box copy (for sale) is in no number
 * here, building sets included. `exact` is false only for
 * a collector whose tally was never kept and who holds more than
 * `MAX_TALLY_RECOUNT_LINES` line items: the numbers are then a floor
 * ("5,000+"), until their next write counts them.
 *
 * NEO-359 — `offBuildCards` is "Everything else": distinct cards not in any
 * set the caller is building, the tally's cards minus each building set's
 * kept `cards` (one read per set build, at most `MAX_BUILDING_SETS`). A set
 * build whose count is not kept is counted by hand, from at most
 * `MAX_BUILDING_CARDS_RECOUNT_LINES` lines over all of them; past that
 * `offBuildExact` is false and the number is unknown, not a floor.
 */
export const summary = query({
  args: {},
  returns: v.object({
    copies: v.number(),
    lines: v.number(),
    distinctCards: v.number(),
    buildingSets: v.number(),
    exact: v.boolean(),
    /** NEO-359 — distinct cards off every set build ("Everything else"). */
    offBuildCards: v.number(),
    /** False when `offBuildCards` could not be counted exactly: read it as unknown. */
    offBuildExact: v.boolean(),
  }),
  handler: async (ctx) => {
    const ownerId = await requireSignedIn(ctx);
    const main = await ctx.db
      .query("collectionContainers")
      .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId).eq("system", "main"))
      .first();
    const kept = keptTally(main);
    const counted = kept ? { tally: kept, exact: true } : await recountTally(ctx, ownerId);
    const building = await ctx.db
      .query("collectionBuildingSets")
      .withIndex("by_owner_and_set", (q) => q.eq("ownerId", ownerId))
      .take(MAX_BUILDING_SETS + 1);
    const recounted = "rows" in counted ? counted.rows : null;
    const onBuilds = await cardsOnBuilds(ctx, ownerId, building, recounted);
    return {
      copies: counted.tally.copies,
      lines: counted.tally.lines,
      distinctCards: counted.tally.cards,
      buildingSets: building.length,
      exact: counted.exact,
      // Clamped: while the catalog re-points a moved card's copies, a card
      // can briefly name two sets.
      offBuildCards: Math.max(0, counted.tally.cards - onBuilds.cards),
      offBuildExact: counted.exact && onBuilds.exact && building.length <= MAX_BUILDING_SETS,
    };
  },
});

/** One card the caller holds, as "Everything I own" lists it. NEO-364: binder lines only. */
export const ownedCardValidator = v.object({
  cardId: v.id("cardChecklist"),
  /** Physical copies, over every collection (binder) line of the card. */
  quantity: v.number(),
  /** Collection (binder) line items of the card. */
  lines: v.number(),
  /** When the card's newest collection line was last touched. */
  lastUpdated: v.number(),
  /** NEO-359: true when any collection line of the card is graded (a slab): "Slabs only". */
  graded: v.boolean(),
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
 *
 * NEO-364 — the collection side only: a line whose home is a box is skipped
 * (it spends the page like any line), a card is listed at its newest BINDER
 * line, its numbers are over its binder lines, and a card held only in boxes
 * is never listed. The pages still walk every line (no index splits the
 * sides), so a box-heavy collection can return empty pages; the caller keeps
 * asking until `isDone`.
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
    const sides = new HomeSides(ctx, ownerId);
    for (const line of result.page) {
      if (seen.has(line.cardId)) continue;
      if (!(await sides.is(line.homeId, "collection"))) continue;
      seen.add(line.cardId);
      const all = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", line.cardId))
        .take(MAX_LINES_PER_CARD);
      const lines = await sides.keep(all, "collection");
      if (lines.some((other) => newerLine(other, line))) continue;
      let quantity = 0;
      let graded = false;
      for (const other of lines) {
        quantity += other.quantity;
        if (other.grading) graded = true;
      }
      page.push({
        cardId: line.cardId,
        quantity,
        lines: lines.length,
        lastUpdated: line.lastUpdated,
        graded,
      });
    }
    return { ...result, page };
  },
});

/**
 * Does `a` come before `b` in `ownedCards`' order? The index's: `lastUpdated`
 * descending, then `_creationTime` (every index ends in it) descending.
 */
export function newerLine(a: CopyRow, b: CopyRow): boolean {
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

/**
 * NEO-359 — the scope a read names (`homeId`, from the URL's `scope=`):
 * `undefined` when there is none (every home on the side), the home's id when
 * it is one of the caller's homes, and `null` when the id is bad, not the
 * caller's, or not a home (the Want List, Up for Trade): the read is then
 * empty. NEO-364: a home on the OTHER side (a box asked for on the
 * collection side, a binder on the inventory side) is `null` too.
 */
async function readScope(
  ctx: Pick<QueryCtx, "db">,
  ownerId: string,
  raw: string | undefined,
  side: Side,
): Promise<Id<"collectionContainers"> | null | undefined> {
  if (raw === undefined) return undefined;
  const id = ctx.db.normalizeId("collectionContainers", raw);
  if (!id) return null;
  const home = await ctx.db.get(id);
  if (!home || home.ownerId !== ownerId) return null;
  if (home.system === "want" || home.system === "trade" || home.rule !== undefined) return null;
  if (sideOfContainer(home) !== side) return null;
  return id;
}

/**
 * NEO-364 — the `side` a read takes, optional for the release only: a tab
 * still running the SPA bundle from before NEO-364 sends no `side`, and a
 * required arg would make its query throw until it reloads. Omitted reads as
 * `"collection"` (what those bundles showed, binders only; never a box
 * copy). The new client always sends it.
 */
const readSideValidator = v.optional(sideValidator);
const sideOf = (side: Side | undefined): Side => side ?? "collection";

/**
 * The caller's line items across one variant (a checklist's worth); NEO-359:
 * in one home when scoped. NEO-364: on one `side` only (binder lines or box
 * lines); a scope on the other side reads as empty.
 */
export const copiesInVariant = query({
  args: { variantId: v.string(), homeId: v.optional(v.string()), side: readSideValidator },
  returns: v.array(copyValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const side = sideOf(args.side);
    const variantId = ctx.db.normalizeId("selectorOptions", args.variantId);
    if (!variantId) return [];
    const homeId = await readScope(ctx, ownerId, args.homeId, side);
    if (homeId === null) return [];
    const setId = await findSetForSelectorOption(ctx, variantId);
    if (!setId) return [];
    const rows =
      homeId === undefined
        ? await ctx.db
            .query("collectionCopies")
            .withIndex("by_owner_set_variant", (q) =>
              q.eq("ownerId", ownerId).eq("setId", setId).eq("variantId", variantId),
            )
            .take(MAX_VARIANT_COPIES)
        : await ctx.db
            .query("collectionCopies")
            .withIndex("by_owner_home_set_variant", (q) =>
              q
                .eq("ownerId", ownerId)
                .eq("homeId", homeId)
                .eq("setId", setId)
                .eq("variantId", variantId),
            )
            .take(MAX_VARIANT_COPIES);
    const onSide = homeId === undefined ? await new HomeSides(ctx, ownerId).keep(rows, side) : rows;
    return onSide.map(copyOut);
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
 * Null for an id that is not a card-bearing row. NEO-359: with `homeId`,
 * owned counts only the copies in that home (a bad or foreign scope owns
 * nothing); the totals are the variant's either way. NEO-364: owned counts
 * only the copies on `side` (a scope on the other side owns nothing).
 */
export const variantCompletion = query({
  args: { variantId: v.string(), homeId: v.optional(v.string()), side: readSideValidator },
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
    const side = sideOf(args.side);
    const variantId = ctx.db.normalizeId("selectorOptions", args.variantId);
    if (!variantId) return null;
    const row = await ctx.db.get(variantId);
    if (
      !row ||
      (row.level !== "variantType" && row.level !== "insert" && row.level !== "parallel")
    ) {
      return null;
    }
    const homeId = await readScope(ctx, ownerId, args.homeId, side);
    const setId = homeId === null ? null : await findSetForSelectorOption(ctx, variantId);
    let copies: CopyRow[] = [];
    if (setId && homeId === undefined) {
      const rows = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_set_variant", (q) =>
          q.eq("ownerId", ownerId).eq("setId", setId).eq("variantId", variantId),
        )
        .take(MAX_VARIANT_COPIES);
      copies = await new HomeSides(ctx, ownerId).keep(rows, side);
    } else if (setId && homeId) {
      copies = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_home_set_variant", (q) =>
          q.eq("ownerId", ownerId).eq("homeId", homeId).eq("setId", setId).eq("variantId", variantId),
        )
        .take(MAX_VARIANT_COPIES);
    }
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
 * (`ownedAll`). Totals come from `collectionCatalog.setSummary`. NEO-359:
 * with `homeId`, only the copies in that home. NEO-364: only the copies on
 * `side`; `truncated` is over the lines read, either side.
 */
export const setCompletion = query({
  args: { setId: v.string(), homeId: v.optional(v.string()), side: readSideValidator },
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
    const side = sideOf(args.side);
    const empty = { owned: 0, ownedAll: 0, variants: [], truncated: false };
    const setId = ctx.db.normalizeId("selectorOptions", args.setId);
    if (!setId) return empty;
    const homeId = await readScope(ctx, ownerId, args.homeId, side);
    if (homeId === null) return empty;
    const read =
      homeId === undefined
        ? await ctx.db
            .query("collectionCopies")
            .withIndex("by_owner_set_variant", (q) => q.eq("ownerId", ownerId).eq("setId", setId))
            .take(MAX_SUMMARY_LINES + 1)
        : await ctx.db
            .query("collectionCopies")
            .withIndex("by_owner_home_set_variant", (q) =>
              q.eq("ownerId", ownerId).eq("homeId", homeId).eq("setId", setId),
            )
            .take(MAX_SUMMARY_LINES + 1);
    const truncated = read.length > MAX_SUMMARY_LINES;
    const kept = read.slice(0, MAX_SUMMARY_LINES);
    const rows = homeId === undefined ? await new HomeSides(ctx, ownerId).keep(kept, side) : kept;
    const byVariant = new Map<string, { variantId: Id<"selectorOptions">; cards: Set<string> }>();
    for (const row of rows) {
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

/** A page size asked of a paginated read, clamped to 1..`max`. */
function pageSize(asked: number, max: number): number {
  const n = Math.floor(asked);
  return Math.max(1, Math.min(Number.isFinite(n) ? n : 1, max));
}

const EMPTY_PAGE = { page: [], isDone: true, continueCursor: "" };

/**
 * NEO-359 — one container's line items, a page at a time
 * (`usePaginatedQuery`), in slot order (not placed first, then pocket or row,
 * oldest first within one). A home lists the copies whose home it is; the Up
 * for Trade shelf lists the flagged copies (as `tradeCopies`); the Want List
 * holds no copies. A bad id, or a container that is not the caller's, reads
 * as an empty page. At most `MAX_CONTAINER_PAGE` lines a page.
 */
export const copiesInContainer = query({
  args: { containerId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(copyValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const id = ctx.db.normalizeId("collectionContainers", args.containerId);
    const container = id ? await ctx.db.get(id) : null;
    if (!container || container.ownerId !== ownerId || container.system === "want") {
      return EMPTY_PAGE;
    }
    const opts = {
      ...args.paginationOpts,
      numItems: pageSize(args.paginationOpts.numItems, MAX_CONTAINER_PAGE),
    };
    const result =
      container.system === "trade"
        ? await ctx.db
            .query("collectionCopies")
            .withIndex("by_owner_and_trade", (q) => q.eq("ownerId", ownerId).eq("upForTrade", true))
            .paginate(opts)
        : await ctx.db
            .query("collectionCopies")
            .withIndex("by_owner_home_slot", (q) =>
              q.eq("ownerId", ownerId).eq("homeId", container._id),
            )
            .paginate(opts);
    return { ...result, page: result.page.map(copyOut) };
  },
});

/**
 * NEO-359 — every line item the caller flagged Up for Trade, wherever it
 * lives, a page at a time (oldest flag-holder first). At most
 * `MAX_CONTAINER_PAGE` lines a page.
 */
export const tradeCopies = query({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(copyValidator),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const result = await ctx.db
      .query("collectionCopies")
      .withIndex("by_owner_and_trade", (q) => q.eq("ownerId", ownerId).eq("upForTrade", true))
      .paginate({
        ...args.paginationOpts,
        numItems: pageSize(args.paginationOpts.numItems, MAX_CONTAINER_PAGE),
      });
    return { ...result, page: result.page.map(copyOut) };
  },
});

/**
 * NEO-359 — the caller's line items of up to `MAX_COPIES_OF_MANY` cards at
 * once (the card hunt: "which of these do I have, and where?"), aligned with
 * `cardIds`, at most `MAX_COPIES_OF_MANY_LINES_PER_CARD` lines each (oldest
 * first). A bad id reads as no copies.
 */
export const copiesOfMany = query({
  args: { cardIds: v.array(v.string()) },
  returns: v.array(v.object({ cardId: v.string(), copies: v.array(copyValidator) })),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    if (args.cardIds.length > MAX_COPIES_OF_MANY) {
      refuse(COLLECTION_ERRORS.limit, `That's more than ${MAX_COPIES_OF_MANY} cards at once. Look them up in smaller bites.`);
    }
    const out = [];
    for (const raw of args.cardIds) {
      const cardId = ctx.db.normalizeId("cardChecklist", raw);
      const rows = cardId
        ? await ctx.db
            .query("collectionCopies")
            .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", cardId))
            .take(MAX_COPIES_OF_MANY_LINES_PER_CARD)
        : [];
      out.push({ cardId: raw, copies: rows.map(copyOut) });
    }
    return out;
  },
});

/**
 * A place in whole-set browse: just after the card at (`s`, `t`) =
 * (`sortOrder`, `_creationTime`) on variant `v`, or the start of `v` when
 * `s` and `t` are absent. Serialised as JSON in the page cursors.
 */
type SetCardsPosition = { v: string; s?: number; t?: number };

function parseSetCardsCursor(raw: string | null | undefined): SetCardsPosition | null {
  if (!raw) return null;
  try {
    const x = JSON.parse(raw) as unknown;
    if (!x || typeof x !== "object") return null;
    const { v: variant, s, t } = x as Record<string, unknown>;
    if (typeof variant !== "string") return null;
    if (s === undefined && t === undefined) return { v: variant };
    if (typeof s !== "number" || typeof t !== "number") return null;
    return { v: variant, s, t };
  } catch {
    return null;
  }
}

/** Is card (`s`, `t`) at or before `end`, inside one variant? */
function atOrBefore(card: { sortOrder: number; _creationTime: number }, end: SetCardsPosition): boolean {
  if (end.s === undefined || end.t === undefined) return false;
  if (card.sortOrder !== end.s) return card.sortOrder < end.s;
  return card._creationTime <= end.t;
}

/**
 * NEO-359 — a whole set's cards for Browse, a page at a time
 * (`usePaginatedQuery`), every checklist in the set's display order (the same
 * walk as `collectionCatalog.setSummary`, rows known to be empty skipped),
 * each checklist in `sortOrder`. A real set can hold 15,000 cards, so nothing
 * reads it whole: a page reads at most `MAX_SET_CARDS_PAGE` cards (and the
 * set's variant rows). A page may run across checklists; every card carries
 * its `variantId`, set and variant. NB fields only (`lib/catalogView.ts`).
 *
 * The cursors are this query's own (a variant, a `sortOrder` and a
 * `_creationTime`), paged with `.take()`, so a page can cross variants
 * (Convex allows one `.paginate()` per function). `endCursor` is honoured:
 * a page re-run with one returns exactly the cards up to it (at most
 * `MAX_SET_CARDS_PAGE`) and hands it back as its `continueCursor`, so the
 * pages stay joined while cards are added. An unknown set, or a cursor whose
 * variant has been deleted, reads as an empty, finished page.
 */
export const cardsInSet = query({
  args: { setId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(catalogCardWithPathValidator),
  handler: async (ctx, args) => {
    await requireSignedIn(ctx);
    const setId = ctx.db.normalizeId("selectorOptions", args.setId);
    const setRow = setId ? await ctx.db.get(setId) : null;
    if (!setId || !setRow || setRow.level !== "setName") return EMPTY_PAGE;

    const variants: Array<Id<"selectorOptions">> = [];
    const hidden = new Set<string>();
    await walkSetVariants(ctx, setId, async (row) => {
      if (variants.length >= MAX_SET_VARIANTS) return false;
      variants.push(row._id);
      if (hiddenAsEmpty(row)) hidden.add(row._id);
      return true;
    });

    const start = parseSetCardsCursor(args.paginationOpts.cursor);
    let index = start ? variants.indexOf(start.v as Id<"selectorOptions">) : 0;
    if (index < 0) {
      return { page: [], isDone: true, continueCursor: args.paginationOpts.cursor ?? "" };
    }
    let after: SetCardsPosition | null = start && start.s !== undefined ? start : null;
    const endRaw = args.paginationOpts.endCursor ?? null;
    const end = parseSetCardsCursor(endRaw);
    const endIndex = end ? variants.indexOf(end.v as Id<"selectorOptions">) : -1;
    const bounded = end !== null && endIndex >= index;
    const limit = bounded
      ? MAX_SET_CARDS_PAGE
      : pageSize(args.paginationOpts.numItems, MAX_SET_CARDS_PAGE);

    const rows: Array<Doc<"cardChecklist">> = [];
    let reachedEnd = false;
    while (index < variants.length && rows.length < limit && !reachedEnd) {
      const variantId = variants[index];
      if (!hidden.has(variantId)) {
        const want = limit - rows.length;
        let batch: Array<Doc<"cardChecklist">>;
        if (after && after.s !== undefined && after.t !== undefined) {
          const { s, t } = after;
          const same = await ctx.db
            .query("cardChecklist")
            .withIndex("by_selector_option_and_sort", (q) =>
              q.eq("selectorOptionId", variantId).eq("sortOrder", s).gt("_creationTime", t),
            )
            .take(want);
          const later =
            same.length < want
              ? await ctx.db
                  .query("cardChecklist")
                  .withIndex("by_selector_option_and_sort", (q) =>
                    q.eq("selectorOptionId", variantId).gt("sortOrder", s),
                  )
                  .take(want - same.length)
              : [];
          batch = [...same, ...later];
        } else {
          batch = await ctx.db
            .query("cardChecklist")
            .withIndex("by_selector_option_and_sort", (q) => q.eq("selectorOptionId", variantId))
            .take(want);
        }
        for (const card of batch) {
          if (bounded && index === endIndex && !atOrBefore(card, end!)) {
            reachedEnd = true;
            break;
          }
          rows.push(card);
        }
        if (rows.length >= limit) break;
      }
      if (bounded && index === endIndex) {
        reachedEnd = true;
        break;
      }
      index += 1;
      after = null;
    }

    const reader = new CatalogReader(ctx);
    const page = [];
    for (const row of rows) page.push(await reader.cardWithPath(row));
    const last = rows[rows.length - 1];
    const isDone = !reachedEnd && index >= variants.length;
    const continueCursor = bounded
      ? endRaw!
      : last
        ? JSON.stringify({ v: last.selectorOptionId, s: last.sortOrder, t: last._creationTime })
        : (args.paginationOpts.cursor ?? "");
    return { page, isDone, continueCursor };
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

/**
 * "I have this one": one raw copy, folding like any add. NEO-359: into
 * `homeId` (the scoped binder or box) when given, else Main.
 */
export const addHave = mutation({
  args: {
    cardId: v.id("cardChecklist"),
    acquiredOn: v.optional(v.string()),
    homeId: v.optional(v.id("collectionContainers")),
  },
  returns: addResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const { result, change } = await addOne(
      ctx,
      ownerId,
      args.cardId,
      haveDetails(args.acquiredOn, args.homeId),
    );
    await applyCopyChanges(ctx, ownerId, [change]);
    return result;
  },
});

/** `addHave` for up to `MAX_BATCH` cards at once (a pasted range). One result per card, in order. */
export const addHaves = mutation({
  args: {
    cardIds: v.array(v.id("cardChecklist")),
    acquiredOn: v.optional(v.string()),
    homeId: v.optional(v.id("collectionContainers")),
  },
  returns: v.array(v.object({ cardId: v.id("cardChecklist"), ...addResultValidator.fields })),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    if (args.cardIds.length > MAX_BATCH) {
      refuse(COLLECTION_ERRORS.limit, `That's more than ${MAX_BATCH} cards at once. Add them in smaller bites.`);
    }
    const out = [];
    const changes: CountChange[] = [];
    for (const cardId of args.cardIds) {
      const added = await addOne(ctx, ownerId, cardId, haveDetails(args.acquiredOn, args.homeId));
      out.push({ cardId, ...added.result });
      changes.push(added.change);
    }
    await applyCopyChanges(ctx, ownerId, changes);
    return out;
  },
});

/** Add a line item with full details. Folds into an identical row (see the header). */
export const addLineItem = mutation({
  args: { cardId: v.id("cardChecklist"), details: copyDetailsValidator },
  returns: addResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const { result, change } = await addOne(ctx, ownerId, args.cardId, args.details);
    await applyCopyChanges(ctx, ownerId, [change]);
    return result;
  },
});

/**
 * Replace a line item's details (absent optional fields are cleared, `slot`
 * and `upForTrade` included, except that a card in a binder keeps its pocket). Never folds into a sibling, so the undo
 * (`updateCopy` with `previous`) always lands on the same row. NEO-359: never
 * changes the home: a `homeId` other than the copy's own is refused (that is
 * `moveCopy`); absent keeps it.
 */
export const updateCopy = mutation({
  args: { copyId: v.id("collectionCopies"), details: copyDetailsValidator },
  returns: v.object({ previous: copyDetailsValidator }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownCopy(ctx, ownerId, args.copyId);
    if (args.details.homeId !== undefined && args.details.homeId !== row.homeId) {
      refuse(COLLECTION_ERRORS.invalid, "To put this copy somewhere else, move it. Editing keeps it where it lives.");
    }
    const cleaned = cleanDetails(args.details);
    const home = await ctx.db.get(row.homeId);
    if (home) {
      checkSlot(home, cleaned.slot);
      if (cleaned.slot === undefined && keepsPockets(home)) {
        cleaned.slot = row.slot ?? (await firstOpenPocket(ctx, ownerId, home._id));
      }
      if (cleaned.slot !== row.slot) {
        await assertPocketFree(ctx, ownerId, home, cleaned.slot, [row._id]);
        await pocketEmptied(ctx, row.homeId, row.slot);
      }
    }
    const previous = detailsOf(row);
    await ctx.db.replace(row._id, {
      ownerId: row.ownerId,
      cardId: row.cardId,
      variantId: row.variantId,
      setId: row.setId,
      ...cleaned,
      homeId: row.homeId,
      lastUpdated: Date.now(),
    });
    await applyCopyChanges(ctx, ownerId, [
      changeOf(row, counted(row), counted({ ...cleaned, homeId: row.homeId })),
    ]);
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
    await pocketEmptied(ctx, row.homeId, row.slot);
    await applyCopyChanges(ctx, ownerId, [changeOf(row, counted(row), null)]);
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
    for (const row of rows) {
      await ctx.db.delete(row._id);
      await pocketEmptied(ctx, row.homeId, row.slot);
    }
    await applyCopyChanges(
      ctx,
      ownerId,
      rows.map((row) => changeOf(row, counted(row), null)),
    );
    return { removed: rows.map((row) => ({ cardId: row.cardId, details: detailsOf(row) })) };
  },
});

/**
 * Put a removed line item back (the undo of `removeCopy`). Inserts a new row
 * with the same details; never folds, so a second undo-of-the-undo removes
 * exactly this row. Refuses when the card has left the catalog or the home
 * is no longer the caller's. NEO-359: if its binder pocket has been filled
 * since, the copy comes back to the same binder in its first open pocket,
 * rather than being refused.
 */
export const restoreCopy = mutation({
  args: { cardId: v.id("cardChecklist"), details: copyDetailsValidator },
  returns: v.object({ copyId: v.id("collectionCopies") }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const cleaned = cleanDetails(args.details);
    const home = await resolveHome(ctx, ownerId, args.details.homeId);
    checkSlot(home, cleaned.slot);
    if (!(await pocketIsFree(ctx, ownerId, home, cleaned.slot))) delete cleaned.slot;
    if (cleaned.slot === undefined && keepsPockets(home)) {
      cleaned.slot = await firstOpenPocket(ctx, ownerId, home._id);
    }
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
      homeId: home._id,
      lastUpdated: Date.now(),
    });
    await applyCopyChanges(ctx, ownerId, [
      changeOf({ cardId: args.cardId, setId: place.setId }, null, counted({ ...cleaned, homeId: home._id })),
    ]);
    return { copyId };
  },
});

/**
 * NEO-359 — move `quantity` of a line item (default: all of it) to another
 * home, at `slot` (absent: a binder's first open pocket, else not placed). Folds into an identical
 * line at the destination; part of a stack splits off. The result's `from`
 * is the undo: move `from.quantity` of `copyId` back to `from.homeId` at
 * `from.slot`, which splits the cards back out of a fold. Refuses the Want
 * List, Up for Trade, and a binder pocket another line item holds. The trade
 * flag travels with the cards.
 */
export const moveCopy = mutation({
  args: {
    copyId: v.id("collectionCopies"),
    toHomeId: v.id("collectionContainers"),
    quantity: v.optional(v.number()),
    slot: v.optional(v.number()),
  },
  returns: moveResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownCopy(ctx, ownerId, args.copyId);
    return await moveCopyCore(ctx, ownerId, row, args.toHomeId, args.quantity, args.slot);
  },
});

/**
 * NEO-359 — put a whole line item in a pocket or row of the home it is in
 * (`null`: take it out of its box row; refused in a binder, where every
 * card sits in a pocket). The same-home `moveCopy`, so it folds
 * into an identical line already in that row and returns the same result
 * (undo = the inverse move).
 */
export const placeCopy = mutation({
  args: { copyId: v.id("collectionCopies"), slot: v.union(v.number(), v.null()) },
  returns: moveResultValidator,
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownCopy(ctx, ownerId, args.copyId);
    if (args.slot === null) {
      const home = await ctx.db.get(row.homeId);
      if (home && keepsPockets(home)) {
        refuse(COLLECTION_ERRORS.invalid, "A card in a binder always sits in a pocket. Move it to another pocket instead.");
      }
    }
    return await moveCopyCore(ctx, ownerId, row, row.homeId, undefined, args.slot ?? undefined);
  },
});

/**
 * NEO-359 — flag a line item Up for Trade, or take the flag off. The copy
 * stays where it lives; it never folds. `previous` is the flag before (undo =
 * `setTrade` with it). Needs no Up for Trade row: its count moves only when
 * the row exists.
 */
export const setTrade = mutation({
  args: { copyId: v.id("collectionCopies"), on: v.boolean() },
  returns: v.object({ previous: v.boolean() }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const row = await ownCopy(ctx, ownerId, args.copyId);
    const previous = row.upForTrade === true;
    if (previous === args.on) return { previous };
    await ctx.db.patch(row._id, {
      upForTrade: args.on ? true : undefined,
      lastUpdated: Date.now(),
    });
    await applyCopyChanges(ctx, ownerId, [
      changeOf(row, counted(row), {
        homeId: row.homeId,
        quantity: row.quantity,
        ...(args.on ? { upForTrade: true as const } : {}),
      }),
    ]);
    return { previous };
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
    // NEO-359 — born counted when the count can finish (see the schema);
    // NEO-364: collection homes only, stamped so.
    const cards = await countSetCards(ctx, ownerId, args.setId, {
      left: MAX_BUILDING_CARDS_RECOUNT_LINES,
    });
    await ctx.db.insert("collectionBuildingSets", {
      ownerId,
      setId: args.setId,
      ...(cards !== null ? { cards, tallyScope: "collection" as const } : {}),
      lastUpdated: Date.now(),
    });
    return { changed: true };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// NEO-364 — the armed recount: collection-only tallies
// ───────────────────────────────────────────────────────────────────────────

/**
 * NEO-364 — optional clean-up after deploy: settle every tally and
 * building-set count from before NEO-364 (they counted boxes too).
 *
 * It is not needed for correctness: a tally or `cards` without
 * `tallyScope: "collection"` already reads as not kept, so the next write
 * recounts it collection-only and stamps it, and a read counts by hand until
 * then. This only spares those hand counts:
 *
 *   - an owner with NO box: the old number counted binders only anyway, so
 *     it is stamped as it is (Main's tally and each counted building set);
 *   - an owner with a box: Main's tally and the unstamped building-set
 *     `cards` are cleared (absent = count by hand, then kept again on the
 *     next write).
 *
 * ## Operator command
 *
 *   # 1. dry run (the default): reports what an armed run would do, writes nothing
 *   npx convex run collection:recountCollectionTallies '{}'
 *
 *   # 2. arm the deployment, run for real, disarm
 *   npx convex env set ALLOW_COLLECTION_BACKFILL 1
 *   npx convex run collection:recountCollectionTallies '{"confirm":"RECOUNT"}'
 *   npx convex env remove ALLOW_COLLECTION_BACKFILL
 *
 * Two arming steps, the project rule: `confirm` is per invocation, the env
 * flag per deployment. An armed invocation on an unarmed deployment comes
 * back `refused` with the dry-run report. Internal, so no identity: reaching
 * it takes deploy credentials. Idempotent: a second run finds every row
 * stamped or cleared and writes nothing.
 *
 * It pages `collectionContainers` (no index on `system` alone) a page per
 * mutation, looped here, so no single transaction reads more than one page
 * of owners. Owners with building sets but no Main (they never held a copy)
 * are not visited; their counts are recounted on first use.
 */
const RECOUNT_CONFIRM = "RECOUNT";
const RECOUNT_ENV_FLAG = "ALLOW_COLLECTION_BACKFILL";
/** Containers one page reads; each Main also reads its owner's containers and set builds. */
const RECOUNT_PAGE = 20;
/** A stop for a runaway loop, far above any real table. */
const RECOUNT_MAX_PAGES = 100_000;

function recountIsArmed(): boolean {
  const value = process.env[RECOUNT_ENV_FLAG];
  return value === "1" || value === "true";
}

const recountTotalsFields = {
  /** Main rows seen (one per owner who ever held a copy). */
  mains: v.number(),
  /** Owners whose tally and set builds were already collection-only (or never counted). */
  alreadyScoped: v.number(),
  /** Owners with no box whose old numbers were stamped as they are. */
  stamped: v.number(),
  /** Owners with a box whose old numbers were cleared. */
  cleared: v.number(),
  /** Building-set rows stamped (no-box owners). */
  buildingStamped: v.number(),
  /** Building-set rows cleared (owners with a box). */
  buildingCleared: v.number(),
};

type RecountTotals = { [K in keyof typeof recountTotalsFields]: number };

export const recountCollectionTalliesPage = internalMutation({
  args: { cursor: v.union(v.string(), v.null()), write: v.boolean() },
  returns: v.object({
    continueCursor: v.string(),
    isDone: v.boolean(),
    ...recountTotalsFields,
  }),
  handler: async (ctx, args) => {
    // Re-asserts the arming itself: a direct `npx convex run` of this page
    // with `write: true` must not bypass the action's two-step gate.
    if (args.write && !recountIsArmed()) {
      throw new ConvexError(
        `Refused: this deployment is not armed. Set ${RECOUNT_ENV_FLAG}=1 on it to write. Nothing was written.`,
      );
    }
    const result = await ctx.db
      .query("collectionContainers")
      .paginate({ cursor: args.cursor, numItems: RECOUNT_PAGE });
    const totals: RecountTotals = {
      mains: 0,
      alreadyScoped: 0,
      stamped: 0,
      cleared: 0,
      buildingStamped: 0,
      buildingCleared: 0,
    };
    for (const main of result.page) {
      if (main.system !== "main") continue;
      totals.mains += 1;
      const ownerId = main.ownerId;
      const oldTally = main.tally !== undefined && main.tallyScope !== "collection";
      const builds = await ctx.db
        .query("collectionBuildingSets")
        .withIndex("by_owner_and_set", (q) => q.eq("ownerId", ownerId))
        .take(MAX_BUILDING_SETS + 1);
      const oldBuilds = builds.filter((b) => b.cards !== undefined && b.tallyScope !== "collection");
      if (!oldTally && oldBuilds.length === 0) {
        totals.alreadyScoped += 1;
        continue;
      }
      const containers = await ctx.db
        .query("collectionContainers")
        .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId))
        .take(MAX_CONTAINERS + MAX_SYSTEM_CONTAINERS);
      const hasBox = containers.some((c) => sideOfContainer(c) === "inventory");
      if (hasBox) {
        totals.cleared += 1;
        totals.buildingCleared += oldBuilds.length;
        if (args.write) {
          if (oldTally) await ctx.db.patch(main._id, { tally: undefined, tallyScope: undefined });
          for (const b of oldBuilds) await ctx.db.patch(b._id, { cards: undefined, tallyScope: undefined });
        }
      } else {
        totals.stamped += 1;
        totals.buildingStamped += oldBuilds.length;
        if (args.write) {
          if (oldTally) await ctx.db.patch(main._id, { tallyScope: "collection" });
          for (const b of oldBuilds) await ctx.db.patch(b._id, { tallyScope: "collection" });
        }
      }
    }
    return { continueCursor: result.continueCursor, isDone: result.isDone, ...totals };
  },
});

export const recountCollectionTallies = internalAction({
  args: { confirm: v.optional(v.string()) },
  returns: v.object({
    mode: v.union(v.literal("dry-run"), v.literal("armed"), v.literal("refused")),
    message: v.optional(v.string()),
    pages: v.number(),
    ...recountTotalsFields,
  }),
  handler: async (ctx, args) => {
    const asked = args.confirm === RECOUNT_CONFIRM;
    const write = asked && recountIsArmed();
    let message: string | undefined;
    if (args.confirm !== undefined && !asked) {
      message = `Dry run: confirm must be exactly "${RECOUNT_CONFIRM}". Nothing was written.`;
    } else if (asked && !write) {
      message =
        `Refused: this deployment is not armed. Set ${RECOUNT_ENV_FLAG}=1 on it, re-run, and remove ` +
        `the flag afterwards. Nothing was written; the report is what an armed run would do.`;
    }
    const totals: RecountTotals = {
      mains: 0,
      alreadyScoped: 0,
      stamped: 0,
      cleared: 0,
      buildingStamped: 0,
      buildingCleared: 0,
    };
    let cursor: string | null = null;
    let pages = 0;
    for (; pages < RECOUNT_MAX_PAGES; ) {
      const page: { continueCursor: string; isDone: boolean } & RecountTotals = await ctx.runMutation(
        internal.collection.recountCollectionTalliesPage,
        { cursor, write },
      );
      pages += 1;
      for (const key of Object.keys(totals) as Array<keyof RecountTotals>) totals[key] += page[key];
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    const mode: "armed" | "refused" | "dry-run" = write ? "armed" : asked ? "refused" : "dry-run";
    return { mode, ...(message ? { message } : {}), pages, ...totals };
  },
});
