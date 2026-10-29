/**
 * NEO-364 — a collector's inventory: the copies whose home is a box (their
 * own boxes and Unsorted), which is to say the cards they have for sale.
 *
 * The hard line (convex/collection.ts, "Collection and inventory"): nothing
 * here reads, counts or writes a binder copy, and nothing here moves the
 * collection tally. Up for Trade is the one shared flag, read off the box
 * lines it sits on.
 *
 * Every function is signed-in (`requireSignedIn`) and reads or writes ONLY the
 * caller's rows (`ownerId` is the caller's Clerk subject, never an argument).
 * A box or card that is not the caller's reads exactly like one that does not
 * exist.
 *
 * ## Quick counts: the plain lines
 *
 * The Inventory checklist sets "how many of this card are in this box" with
 * one number. That number is the card's PLAIN lines in the box: raw in the
 * collector's default condition (NEO-380, `defaultConditionOf`; a line stored
 * before conditions were required, with none, counts too), ungraded, no
 * serial, no cost, no floor price of its own (NEO-378), no location, no notes,
 * not up for trade; where in the box (`slot`) and when acquired (`acquiredOn`)
 * are ignored. Every other line of the card in that box is the collector's own
 * detail and is never touched here (the client shows it beside the number).
 *
 *   - Raise by n: n raw copies in the default condition, acquired today (the caller's today, else the
 *     server's UTC date), not placed in a row, folding into today's plain
 *     unplaced line when there is one (the fold rule, `foldsInto`).
 *   - Lower by n: taken off the plain lines newest first (`newerLine`); a
 *     line that reaches 0 is deleted.
 *   - The same number: nothing is written.
 *
 * Every write returns `inverse`: the exact row-level undo (each touched line
 * put back as it was), which `undoBoxQuantity` applies after checking every
 * line still reads as the write left it. The undo returns its own inverse
 * (the redo). The numbers move through `applyCopyChanges`, like every copy
 * write; for a box that is the box's own count only.
 *
 * NB fields only: no marketplace field is read or written.
 */

import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation, query } from "./_generated/server";
import { requireSignedIn } from "./auth";
import {
  COLLECTION_ERRORS,
  MAX_COPY_QUANTITY,
  MAX_LINES_PER_CARD,
  applyCopyChanges,
  changeOf,
  checkSlot,
  counted,
  defaultConditionOf,
  foldsInto,
  detailsOf,
  isIsoDate,
  newerLine,
  placeOf,
  refuse,
  resolveHome,
  sideOfContainer,
  MAX_CONTAINERS,
  MAX_SYSTEM_CONTAINERS,
  type Condition,
  type CountChange,
  type StoredDetails,
  foldShape,
} from "./collection";

type CopyRow = Doc<"collectionCopies">;
type ContainerRow = Doc<"collectionContainers">;

/** Box line items one `inventoryCards` call reads, at most. */
export const MAX_INVENTORY_LINES = 2000;

// ───────────────────────────────────────────────────────────────────────────
// Validators
// ───────────────────────────────────────────────────────────────────────────

/**
 * One step of a quick count's undo, on one line of the card in the box:
 *   - `remove`: delete the line, which must hold exactly `quantity` (the
 *     undo of an insert);
 *   - `set`: the line holds `from`; make it `to` (the undo of a quantity
 *     change);
 *   - `restore`: put back a deleted plain line (the undo of a delete),
 *     folding into an identical line if one is there now.
 */
export const boxQuantityStepValidator = v.union(
  v.object({
    op: v.literal("remove"),
    copyId: v.id("collectionCopies"),
    quantity: v.number(),
  }),
  v.object({
    op: v.literal("set"),
    copyId: v.id("collectionCopies"),
    from: v.number(),
    to: v.number(),
  }),
  v.object({
    op: v.literal("restore"),
    quantity: v.number(),
    acquiredOn: v.optional(v.string()),
    slot: v.optional(v.number()),
  }),
);

/** What `undoBoxQuantity` takes: the card, the box, and the steps, applied in order. */
export const boxQuantityInverseValidator = v.object({
  cardId: v.id("cardChecklist"),
  boxId: v.id("collectionContainers"),
  steps: v.array(boxQuantityStepValidator),
});

/**
 * A quick count's result: the card's plain copies in the box before and
 * after, and the exact undo. `before === after`: nothing was written and
 * `inverse.steps` is empty.
 */
export const boxQuantityResultValidator = v.object({
  before: v.number(),
  after: v.number(),
  inverse: boxQuantityInverseValidator,
});

type Step = typeof boxQuantityStepValidator.type;
type QuantityResult = typeof boxQuantityResultValidator.type;

/** One card on the Inventory list: every line of it in every box, together. */
export const inventoryCardValidator = v.object({
  cardId: v.id("cardChecklist"),
  /** Physical copies over the card's box lines. */
  quantity: v.number(),
  /** Box line items of the card. */
  lines: v.number(),
  /** True when any box line of the card is graded (a slab). */
  graded: v.boolean(),
  /** Physical copies over the card's graded box lines (slabs): "Slabs only" counts these. */
  gradedQuantity: v.number(),
  /** True when any box line of the card is flagged Up for Trade. */
  upForTrade: v.boolean(),
  /** The newest `lastUpdated` of the card's box lines ("Added"). */
  lastUpdated: v.number(),
  /** Every box it sits in (Unsorted included), in shelf order, with its copies (and slabs) there. */
  boxes: v.array(
    v.object({ boxId: v.id("collectionContainers"), quantity: v.number(), gradedQuantity: v.number() }),
  ),
});

// ───────────────────────────────────────────────────────────────────────────
// Rules
// ───────────────────────────────────────────────────────────────────────────

/**
 * A plain line: what a quick count counts and changes. Raw in the
 * collector's default condition (or with none, from before NEO-380),
 * ungraded, no serial, no cost, no own minimum price, no location, no notes,
 * not up for trade; its slot and acquired date do not matter.
 */
export function isPlainLine(
  row: Pick<
    CopyRow,
    "condition" | "grading" | "serialNumber" | "costCents" | "minPriceCents" | "location" | "notes" | "upForTrade" | "hasPhotos"
  >,
  defaultCondition: Condition,
): boolean {
  return (
    row.hasPhotos !== true &&
    (row.condition === undefined || row.condition === defaultCondition) &&
    row.grading === undefined &&
    row.serialNumber === undefined &&
    row.costCents === undefined &&
    row.minPriceCents === undefined &&
    row.location === undefined &&
    row.notes === undefined &&
    row.upForTrade !== true
  );
}

/** Today as `YYYY-MM-DD` in UTC: the date a quick count stamps when the caller sends none. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A whole number from `min` to `MAX_COPY_QUANTITY`, or a refusal saying so. */
function checkQuantity(raw: number, min: 0 | 1): void {
  if (!Number.isInteger(raw) || raw < min || raw > MAX_COPY_QUANTITY) {
    refuse(COLLECTION_ERRORS.invalid, `Quantity is a whole number from ${min} to ${MAX_COPY_QUANTITY}.`);
  }
}

/** The caller's box (their own or Unsorted), checked; refuses a binder or a shelf row. */
async function ownBox(
  ctx: MutationCtx,
  ownerId: string,
  boxId: Id<"collectionContainers">,
): Promise<ContainerRow> {
  const home = await resolveHome(ctx, ownerId, boxId);
  if (sideOfContainer(home) !== "inventory") {
    refuse(COLLECTION_ERRORS.invalid, "Quick counts go in a box. Pick a box to count into.");
  }
  return home;
}

/** Every line the caller holds of `cardId`, at most `MAX_LINES_PER_CARD + 1`. */
async function linesOfCard(
  ctx: MutationCtx,
  ownerId: string,
  cardId: Id<"cardChecklist">,
): Promise<CopyRow[]> {
  return await ctx.db
    .query("collectionCopies")
    .withIndex("by_owner_and_card", (q) => q.eq("ownerId", ownerId).eq("cardId", cardId))
    .take(MAX_LINES_PER_CARD + 1);
}

/** The card's plain lines in `boxId` and their copies. */
function plainIn(
  lines: ReadonlyArray<CopyRow>,
  boxId: Id<"collectionContainers">,
  defaultCondition: Condition,
): { rows: CopyRow[]; copies: number } {
  const rows = lines.filter((row) => row.homeId === boxId && isPlainLine(row, defaultCondition));
  let copies = 0;
  for (const row of rows) copies += row.quantity;
  return { rows, copies };
}

const CHANGED_SINCE =
  "That count changed since, so it can't be undone. Type the number you want instead.";

type Place = { variantId: Id<"selectorOptions">; setId: Id<"selectorOptions"> };

/**
 * Put `quantity` plain copies of the card in the box with these details, in
 * the collector's default condition:
 * folded into the identical line when there is one (and it has room), else
 * a new line. Returns the step that undoes it, the row change, and the line
 * as it now stands (the folded line patched, or the inserted one), so a
 * caller holding the card's lines in memory can keep them current without
 * reading them again. `place` gives the card's variant and set for an
 * insert; a caller that inserts more than once passes a memo.
 */
async function putPlain(
  ctx: MutationCtx,
  ownerId: string,
  cardId: Id<"cardChecklist">,
  box: ContainerRow,
  lines: ReadonlyArray<CopyRow>,
  details: { quantity: number; acquiredOn?: string; slot?: number },
  defaultCondition: Condition,
  now: number,
  place: () => Promise<Place> = () => placeOf(ctx, cardId),
): Promise<{ undo: Step; change: CountChange; row: CopyRow }> {
  const next: StoredDetails = {
    quantity: details.quantity,
    condition: defaultCondition,
    ...(details.acquiredOn ? { acquiredOn: details.acquiredOn } : {}),
    homeId: box._id,
    ...(details.slot !== undefined ? { slot: details.slot } : {}),
  };
  const into = lines.find(
    (row) => foldsInto(foldShape(row), next) && row.quantity + details.quantity <= MAX_COPY_QUANTITY,
  );
  if (into) {
    const quantity = into.quantity + details.quantity;
    await ctx.db.patch(into._id, { quantity, lastUpdated: now });
    return {
      undo: { op: "set", copyId: into._id, from: quantity, to: into.quantity },
      change: changeOf(into, counted(into), counted({ ...into, quantity })),
      row: { ...into, quantity, lastUpdated: now },
    };
  }
  if (lines.length >= MAX_LINES_PER_CARD) {
    refuse(COLLECTION_ERRORS.limit, `You already have ${MAX_LINES_PER_CARD} lines of this card. Stack some together first.`);
  }
  const { variantId, setId } = await place();
  const fields = { ownerId, cardId, variantId, setId, ...next, lastUpdated: now };
  const copyId = await ctx.db.insert("collectionCopies", fields);
  return {
    undo: { op: "remove", copyId, quantity: details.quantity },
    change: changeOf({ cardId, setId }, null, counted(next)),
    // `_creationTime` is not read back from the database (that would be a
    // read per inserted line); nothing that walks the in-memory lines uses it.
    row: { _id: copyId, _creationTime: now, ...fields },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Mutations
// ───────────────────────────────────────────────────────────────────────────

/**
 * Set how many plain copies of `cardId` are in `boxId` (see the header):
 * raise adds raw copies acquired `acquiredOn` (the caller's today; default
 * the server's UTC date), lower takes them off the plain lines newest first,
 * the same number writes nothing. One transaction. Refuses a binder, a shelf
 * row, a box that is not the caller's, and a number outside 0 to
 * `MAX_COPY_QUANTITY`.
 */
export const setBoxQuantity = mutation({
  args: {
    cardId: v.id("cardChecklist"),
    boxId: v.id("collectionContainers"),
    quantity: v.number(),
    acquiredOn: v.optional(v.string()),
  },
  returns: boxQuantityResultValidator,
  handler: async (ctx, args): Promise<QuantityResult> => {
    const ownerId = await requireSignedIn(ctx);
    checkQuantity(args.quantity, 0);
    const box = await ownBox(ctx, ownerId, args.boxId);
    const acquiredOn = args.acquiredOn?.trim() || utcToday();
    if (!isIsoDate(acquiredOn)) {
      refuse(COLLECTION_ERRORS.invalid, "That acquired date isn't a real date.");
    }
    const lines = await linesOfCard(ctx, ownerId, args.cardId);
    const defaultCondition = await defaultConditionOf(ctx, ownerId);
    const plain = plainIn(lines, box._id, defaultCondition);
    const before = plain.copies;
    const result = (steps: Step[], after: number): QuantityResult => ({
      before,
      after,
      inverse: { cardId: args.cardId, boxId: box._id, steps },
    });
    if (args.quantity === before) return result([], before);

    const now = Date.now();
    const undo: Step[] = [];
    const changes: CountChange[] = [];
    if (args.quantity > before) {
      const put = await putPlain(
        ctx,
        ownerId,
        args.cardId,
        box,
        lines,
        { quantity: args.quantity - before, acquiredOn },
        defaultCondition,
        now,
      );
      undo.push(put.undo);
      changes.push(put.change);
    } else {
      let left = before - args.quantity;
      const newestFirst = [...plain.rows].sort((a, b) => (newerLine(a, b) ? -1 : newerLine(b, a) ? 1 : 0));
      for (const row of newestFirst) {
        if (left === 0) break;
        const take = Math.min(left, row.quantity);
        left -= take;
        if (take === row.quantity) {
          await ctx.db.delete(row._id);
          undo.push({
            op: "restore",
            quantity: row.quantity,
            ...(row.acquiredOn ? { acquiredOn: row.acquiredOn } : {}),
            ...(row.slot !== undefined ? { slot: row.slot } : {}),
          });
          changes.push(changeOf(row, counted(row), null));
        } else {
          const quantity = row.quantity - take;
          await ctx.db.patch(row._id, { quantity, lastUpdated: now });
          undo.push({ op: "set", copyId: row._id, from: quantity, to: row.quantity });
          changes.push(changeOf(row, counted(row), counted({ ...row, quantity })));
        }
      }
    }
    await applyCopyChanges(ctx, ownerId, changes);
    // Undo the last write first.
    return result(undo.reverse(), args.quantity);
  },
});

/**
 * Apply a quick count's `inverse` (the undo; or, given an undo's own
 * inverse, the redo). Every step names a plain line of the card in the box
 * and the quantity it must hold now; anything that changed since refuses the
 * whole undo, writing nothing. Returns the same shape as `setBoxQuantity`,
 * so its `inverse` redoes it.
 */
export const undoBoxQuantity = mutation({
  args: { inverse: boxQuantityInverseValidator },
  returns: boxQuantityResultValidator,
  handler: async (ctx, args): Promise<QuantityResult> => {
    const ownerId = await requireSignedIn(ctx);
    const { cardId, boxId, steps } = args.inverse;
    if (steps.length > MAX_LINES_PER_CARD) refuse(COLLECTION_ERRORS.invalid, CHANGED_SINCE);
    const box = await ownBox(ctx, ownerId, boxId);
    // The card's lines, read ONCE and kept current in memory as each step
    // writes (an insert appended, a patch replaced, a delete dropped), so a
    // restore folds against what earlier steps left without reading the
    // card's lines again: one undo is about one read per step, not one
    // card-wide read per step. The list is the whole card: `linesOfCard`
    // takes one past `MAX_LINES_PER_CARD`, and no write here lets a card pass it.
    const lines: CopyRow[] = await linesOfCard(ctx, ownerId, cardId);
    const keep = (row: CopyRow) => {
      const at = lines.findIndex((line) => line._id === row._id);
      if (at === -1) lines.push(row);
      else lines[at] = row;
    };
    const drop = (copyId: Id<"collectionCopies">) => {
      const at = lines.findIndex((line) => line._id === copyId);
      if (at !== -1) lines.splice(at, 1);
    };
    let place: Promise<Place> | undefined;
    const placeOnce = () => (place ??= placeOf(ctx, cardId));
    const defaultCondition = await defaultConditionOf(ctx, ownerId);
    const before = plainIn(lines, box._id, defaultCondition).copies;
    const now = Date.now();
    const redo: Step[] = [];
    const changes: CountChange[] = [];
    for (const step of steps) {
      if (step.op === "restore") {
        checkQuantity(step.quantity, 1);
        if (step.acquiredOn !== undefined && !isIsoDate(step.acquiredOn)) {
          refuse(COLLECTION_ERRORS.invalid, CHANGED_SINCE);
        }
        if (step.slot !== undefined && (!Number.isInteger(step.slot) || step.slot < 0)) {
          refuse(COLLECTION_ERRORS.invalid, CHANGED_SINCE);
        }
        checkSlot(box, step.slot);
        const put = await putPlain(ctx, ownerId, cardId, box, lines, step, defaultCondition, now, placeOnce);
        keep(put.row);
        redo.push(put.undo);
        changes.push(put.change);
        continue;
      }
      const row = await ctx.db.get(step.copyId);
      if (
        !row ||
        row.ownerId !== ownerId ||
        row.cardId !== cardId ||
        row.homeId !== box._id ||
        !isPlainLine(row, defaultCondition)
      ) {
        refuse(COLLECTION_ERRORS.invalid, CHANGED_SINCE);
      }
      if (step.op === "remove") {
        if (row.quantity !== step.quantity) refuse(COLLECTION_ERRORS.invalid, CHANGED_SINCE);
        await ctx.db.delete(row._id);
        drop(row._id);
        redo.push({
          op: "restore",
          quantity: row.quantity,
          ...(row.acquiredOn ? { acquiredOn: row.acquiredOn } : {}),
          ...(row.slot !== undefined ? { slot: row.slot } : {}),
        });
        changes.push(changeOf(row, counted(row), null));
      } else {
        if (row.quantity !== step.from) refuse(COLLECTION_ERRORS.invalid, CHANGED_SINCE);
        checkQuantity(step.to, 1);
        await ctx.db.patch(row._id, { quantity: step.to, lastUpdated: now });
        keep({ ...row, quantity: step.to, lastUpdated: now });
        redo.push({ op: "set", copyId: row._id, from: step.to, to: row.quantity });
        changes.push(changeOf(row, counted(row), counted({ ...row, quantity: step.to })));
      }
    }
    await applyCopyChanges(ctx, ownerId, changes);
    const after = plainIn(lines, box._id, defaultCondition).copies;
    return { before, after, inverse: { cardId, boxId: box._id, steps: redo.reverse() } };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Queries
// ───────────────────────────────────────────────────────────────────────────

/**
 * The Inventory list: one item per card held in a box, never a binder copy.
 * Walks the caller's boxes in shelf order (Unsorted first, then their own,
 * oldest first) via `by_owner_home_slot`, reading at most `limit` lines
 * (default and most: `MAX_INVENTORY_LINES`); `truncated` says it stopped
 * short. Items are newest first (`lastUpdated`, the card's newest box line).
 * A card that has left the catalog is listed in `goneCardIds` instead (say
 * so; never crash). To see past the limit, the client narrows to one box
 * (`collection.copiesInContainer`, paged).
 */
export const inventoryCards = query({
  args: { limit: v.optional(v.number()) },
  returns: v.object({
    items: v.array(inventoryCardValidator),
    goneCardIds: v.array(v.id("cardChecklist")),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const ownerId = await requireSignedIn(ctx);
    const asked = args.limit === undefined ? MAX_INVENTORY_LINES : Math.floor(args.limit);
    const budget = Math.max(1, Math.min(Number.isFinite(asked) ? asked : 1, MAX_INVENTORY_LINES));
    const containers = await ctx.db
      .query("collectionContainers")
      .withIndex("by_owner_and_system", (q) => q.eq("ownerId", ownerId))
      .take(MAX_CONTAINERS + MAX_SYSTEM_CONTAINERS);
    const boxes = containers
      .filter((row) => sideOfContainer(row) === "inventory")
      .sort(
        (a, b) =>
          (a.system === "unsorted" ? 0 : 1) - (b.system === "unsorted" ? 0 : 1) ||
          a._creationTime - b._creationTime,
      );

    type Entry = typeof inventoryCardValidator.type;
    const byCard = new Map<string, Entry>();
    let read = 0;
    let truncated = false;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      const left = budget - read;
      if (left <= 0) {
        // Out of budget: more lines exist if any box still to walk holds one
        // (by its kept count; an uncounted box may).
        truncated = boxes.slice(i).some((b) => b.count === undefined || b.count.lines > 0);
        break;
      }
      const rows = await ctx.db
        .query("collectionCopies")
        .withIndex("by_owner_home_slot", (q) => q.eq("ownerId", ownerId).eq("homeId", box._id))
        .take(left + 1);
      const kept = rows.length > left ? rows.slice(0, left) : rows;
      if (rows.length > left) truncated = true;
      read += kept.length;
      for (const row of kept) {
        // NEO-361: the inventory list is of catalog cards. A private card's
        // copy (one put in a box) is counted by its box but not listed here.
        const cardId = ctx.db.normalizeId("cardChecklist", row.cardId);
        if (!cardId) continue;
        const entry =
          byCard.get(cardId) ??
          ({
            cardId,
            quantity: 0,
            lines: 0,
            graded: false,
            gradedQuantity: 0,
            upForTrade: false,
            lastUpdated: 0,
            boxes: [],
          } satisfies Entry);
        entry.quantity += row.quantity;
        entry.lines += 1;
        const slabs = row.grading ? row.quantity : 0;
        if (row.grading) entry.graded = true;
        entry.gradedQuantity += slabs;
        if (row.upForTrade === true) entry.upForTrade = true;
        if (row.lastUpdated > entry.lastUpdated) entry.lastUpdated = row.lastUpdated;
        const inBox = entry.boxes.find((b) => b.boxId === box._id);
        if (inBox) {
          inBox.quantity += row.quantity;
          inBox.gradedQuantity += slabs;
        } else entry.boxes.push({ boxId: box._id, quantity: row.quantity, gradedQuantity: slabs });
        byCard.set(cardId, entry);
      }
      if (truncated) break;
    }

    const items: Entry[] = [];
    const goneCardIds: Array<Id<"cardChecklist">> = [];
    for (const entry of byCard.values()) {
      if (await ctx.db.get(entry.cardId)) items.push(entry);
      else goneCardIds.push(entry.cardId);
    }
    items.sort((a, b) => b.lastUpdated - a.lastUpdated);
    return { items, goneCardIds, truncated };
  },
});
