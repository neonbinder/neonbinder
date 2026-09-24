/**
 * NEO-305 — two operator doors that move a SportLots link between a SET and
 * a PARALLEL, keyed by id end to end.
 *
 * ## Why they exist
 *
 * Sync Sets used to file SportLots' flat list under a brand as sets, so
 * "Bowman Blue", "Bowman Gold" and friends became top-level sets beside
 * Bowman when they are Bowman's parallels (Part A of NEO-305 stops that at
 * the sync boundary). The rows already created are fixed here, by hand, and
 * the way back exists for the day the sync files a real SportLots-only set
 * as a flagship parallel:
 *
 *  - `convertSetToParallel` — "Make parallel of…": a set that is nothing but
 *    a Base carrying SportLots links becomes (or joins) a parallel row under
 *    another set's Parallel variant type. Its links, labels and cards move;
 *    the emptied Base and set are deleted in the same transaction.
 *  - `promoteParallelToSet` — "Promote to set": one SportLots link on a
 *    parallel row becomes a set with a Base again (the same shape
 *    `insertSetWithBaseFromSl` mints for the sync), or joins an existing
 *    set's Base. The cards attributed to that link move with it; the
 *    parallel row goes only when nothing is left on it.
 *
 * ## The invariants this file is built around
 *
 *  - KEYED BY ID. A link moves as (marketplace id, label) and lands in a
 *    slot allocated on the destination (`allocateSlots` / `initialSlots`).
 *    A card follows its OWN slot: its `platformData.<side>.src` is remapped
 *    from the source row's slot key to the destination's. Nothing reads a
 *    marketplace name to decide anything; the only names derived here are
 *    the new row's NB name, once, at creation (product invariant 2a).
 *  - A LINK IS NEVER DROPPED. Every SportLots id on the source ends up on the
 *    destination, with its label. A card's ref is never removed; a `src`
 *    that pointed at nothing on the source (already dangling) is cleared
 *    rather than carried, because slot keys are per row — carried over, it
 *    would silently point at whatever the destination holds under that key.
 *  - CARD NUMBERS ARE NEVER ASSUMED UNIQUE. Cards are moved by `_id` and
 *    attributed by slot. Two cards with one number both move, or both stay.
 *  - NEVER GUESS. A card the promote cannot attribute by id to exactly one
 *    side of the split (it carries the promoted SportLots link AND a live BSC
 *    link that stays behind) refuses the whole promote, rather than choosing.
 *
 * ## Sync stickiness
 *
 * `listBrandSubtreeSlIds` walks setName → variantType → insert → parallel, so
 * an id is "covered" wherever under the brand it sits. After a convert the
 * id is on a parallel row and Sync Sets does not re-create the set; after a
 * promote it is on a set's Base and the flagship-parallel routing does not
 * re-absorb it. Both directions stick because both are keyed by id.
 *
 * ## Copy
 *
 * Every refusal is a `ConvexError` carrying one operator sentence (a plain
 * `Error` is redacted to "Server Error" on prod). NB names only, never an id
 * and never an internal word. DRAFT copy pending Jason's sign-off (NEO-245:
 * no copywriter agent).
 */

import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";
import { inheritedTeamIds } from "./lib/selectorTeams";
import {
  allocateSlots,
  detachSlot,
  idForSlot,
  initialSlots,
  primarySlot,
  slotEntries,
  slotForId,
  slotIds,
  slotLabel,
  type PlatformSide,
} from "./platformSlots";
import {
  RESTAMP_MAX_PAGES,
  collectSelectorOptionHoldings,
  deleteEmptySelectorOptionRow,
} from "./selectorOptions";
import {
  checkCustomSelectorValue,
  matchesBrandPrefix,
  selectorValueKey,
  stripMatchedBrandPrefix,
} from "./selectorSyncMatch";
import { unionChildren } from "./selectorSyncStore";
import {
  MAX_YEAR_SET_ROWS,
  candidateDefaultName,
  insertSetWithBaseFromSl,
} from "./setFromMarketplace";
import { derivedVariantFlags, variantTypeRole } from "./variantRole";
import { compareCardNumbers } from "../lib/cards/card-number";

type Row = Doc<"selectorOptions">;
type RowId = Id<"selectorOptions">;
type Card = Doc<"cardChecklist">;

// ───────────────────────────────────────────────────────────────────────────
// Bounds
// ───────────────────────────────────────────────────────────────────────────

/**
 * Cards one move re-parents. Every moved card is one `patch`, and the move is
 * one transaction on purpose (a half-moved checklist is a split set nobody
 * asked for), so this is the transaction bound: the house calibration is
 * ~900 system operations comfortable, ~1,800 straining, ~4,000 failing
 * (`CARDS_PER_COMMIT_CHUNK`). A parallel's checklist mirrors its base set's,
 * and the biggest real base set is well under this, so the refusal exists to
 * fail closed rather than to be met.
 */
export const MAX_CARDS_PER_MOVE = 1500;

/**
 * Guest cross-listings (NEO-21) one convert carries from the emptied rows to
 * the destination. Same reasoning as `MAX_CARDS_PER_MOVE`; a guest list is a
 * handful of cards in practice.
 */
export const MAX_CROSS_LISTINGS_PER_MOVE = 200;

/**
 * Cards a promote READS off the parallel to find the ones attributed to the
 * promoted link (the rest stay). One `.take()` is one operation however many
 * rows it returns, so this bounds document size, not the write budget.
 */
export const MAX_CARDS_PER_ROW_READ = MAX_CARDS_PER_MOVE * 4;

/** Sets the "Make parallel of…" picker lists for one brand. */
export const MAX_TARGET_SETS = 500;

// ───────────────────────────────────────────────────────────────────────────
// Operator sentences (DRAFT — pending Jason's sign-off)
// ───────────────────────────────────────────────────────────────────────────

export const conversionRefusal = {
  setGone: () => "That set is gone. Refresh and try again.",
  notASet: () => "Only a set can become a parallel.",
  onBsc: (set: string) => `BSC lists “${set}” as a set, so it stays a set.`,
  noBase: (set: string) => `“${set}” has no Base to move.`,
  moreThanBase: (set: string) =>
    `“${set}” has more than a Base under it. Clear out its other variant types first.`,
  baseHasRows: (set: string) =>
    `“${set}”’s Base has inserts or parallels under it. Move them out first.`,
  reviewOpen: (set: string) =>
    `A checklist review is open on “${set}”. Finish it, then try again.`,
  targetGone: () => "That Parallel type is gone. Refresh and try again.",
  self: (set: string) => `“${set}” can't be a parallel of itself.`,
  otherBrand: (target: string, brand: string) =>
    `“${target}” is under a different brand. Pick one of ${brand}’s sets.`,
  notParallelType: (type: string, target: string) =>
    `“${type}” under “${target}” isn't a Parallel type. Pick ${target}’s Parallel.`,
  attachGone: () => "That parallel moved. Refresh and try again.",
  ownName: (label: string, target: string) =>
    `“${label}” is ${target}’s own name, so it can't be a new parallel of it. Add it to an existing parallel instead.`,
  nameTaken: (target: string, name: string) =>
    `${target} already has a “${name}” parallel. Add it to that one instead.`,
  /**
   * The destination already holds one of the links. Refused in BOTH modes
   * (coordinator, NEO-305): the destination's own cards for that link are
   * already there, so moving this set's copies in would be a second copy of
   * each card. The remedy names the chip control that removes a link.
   */
  linkTaken: (target: string, name: string, set: string) =>
    `“${name}” under ${target} already has this SportLots link. Remove it from “${name}” first if “${set}” is the one to keep.`,
  badName: (reason: string) => `That name won't work: ${reason}.`,
  tooManyCards: (set: string, max: number) =>
    `“${set}” holds more than ${max.toLocaleString("en-US")} cards — more than one move can carry. Nothing changed.`,
  tooManyGuests: (set: string, max: number) =>
    `“${set}” has more than ${max} cards from other sets listed in it — more than one move can carry. Nothing changed.`,
};

export const promotionRefusal = {
  rowGone: () => "That parallel is gone. Refresh and try again.",
  notAParallel: (row: string) =>
    `“${row}” isn't a parallel of a set, so it can't become one.`,
  linkGone: (row: string) =>
    `That SportLots link isn't on “${row}” any more. Refresh and try again.`,
  noBrand: () => "This parallel has no brand above it. Refresh and try again.",
  nameTaken: (brand: string, set: string) =>
    `${brand} already has a set called “${set}”. Add it to that set's Base instead.`,
  existsElsewhere: (set: string, otherBrand: string, brand: string) =>
    `There's already a “${set}” under ${otherBrand}. Move it to ${brand} with Move to another brand, then try again.`,
  badName: (reason: string) => `That name won't work: ${reason}.`,
  tooManySets: (brand: string) =>
    `${brand} has more than ${MAX_YEAR_SET_ROWS.toLocaleString("en-US")} sets — too many to check this name against. Nothing changed.`,
  attachGone: () => "That set moved. Refresh and try again.",
  attachOtherBrand: (set: string, brand: string) =>
    `“${set}” is under a different brand. Pick one of ${brand}’s sets.`,
  attachNoBase: (set: string) =>
    `“${set}” has no Base yet. Sync its variant types, then try again.`,
  /** The chosen set's Base already holds the link: its cards are there already. */
  linkTaken: (set: string, row: string) =>
    `“${set}”’s Base already has this SportLots link. Remove it from “${row}” instead if that copy isn't needed.`,
  paired: (row: string, count: number) =>
    `${count} ${count === 1 ? "card" : "cards"} on “${row}” ${
      count === 1 ? "is" : "are"
    } matched to BSC as well as SportLots, so ${
      count === 1 ? "it" : "they"
    } can't be split off. Nothing changed.`,
  tooManyCards: (row: string, max: number) =>
    `“${row}” holds more than ${max.toLocaleString("en-US")} cards for that link — more than one move can carry. Nothing changed.`,
  reviewOpen: (row: string) =>
    `A checklist review is open on “${row}”. Finish it, then try again.`,
};

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * The NB name a new parallel is born with: the SportLots label with the
 * target set's name taken off the front (whole word, case-insensitive — the
 * `matchesBrandPrefix` rule), so "Bowman Blue" under Bowman is "Blue" and
 * "Bowman Chrome Blue Refractor" under Bowman Chrome is "Blue Refractor".
 *
 * SportLots files some lists brand-stripped ("Chrome Blue Refractor"), so the
 * target's name without its brand's set-name prefix is tried second. A label
 * that matches neither keeps its whole self.
 *
 * `null` when the label IS the target's name: that entry is the target's own
 * checklist, not a parallel of it, and a parallel called "Bowman" under
 * Bowman is a row nobody wants. Derived once, at creation, and never re-read.
 */
export function parallelNameFromLabel(
  label: string,
  targetSetValue: string,
  brandSetNamePrefix?: string,
): string | null {
  const trimmed = label.trim();
  const prefixes = [targetSetValue.trim()];
  const brandPrefix = brandSetNamePrefix?.trim();
  if (brandPrefix && matchesBrandPrefix(targetSetValue, brandPrefix)) {
    const bare = stripMatchedBrandPrefix(targetSetValue, brandPrefix);
    if (bare !== targetSetValue.trim()) prefixes.push(bare);
  }
  for (const prefix of prefixes) {
    if (!prefix || !matchesBrandPrefix(trimmed, prefix)) continue;
    const rest = stripMatchedBrandPrefix(trimmed, prefix);
    // `stripMatchedBrandPrefix` never strips to nothing — it hands the label
    // back whole — so an unchanged result after a MATCH means "all prefix".
    return rest === trimmed ? null : rest;
  }
  return trimmed;
}

/**
 * A card's `platformData` as it must read on its NEW parent row.
 *
 * `slotMap[side]` maps the SOURCE row's slot keys to the destination's. A ref
 * whose `src` is in the map follows it; a ref whose `src` is not (it pointed
 * at a slot the source row no longer holds, or that stays behind) keeps its
 * ref and loses the `src` — carrying the key over would make it point at
 * whatever the destination happens to hold under that key. Refs are never
 * dropped.
 */
export function remapCardPlatformData(
  platformData: Card["platformData"],
  slotMap: Partial<Record<PlatformSide, ReadonlyMap<string, string>>>,
): Card["platformData"] {
  const out: Card["platformData"] = {};
  for (const side of ["bsc", "sportlots"] as const) {
    const ref = platformData[side];
    if (!ref) continue;
    const next = ref.src !== undefined ? slotMap[side]?.get(ref.src) : undefined;
    out[side] = next !== undefined ? { ref: ref.ref, src: next } : { ref: ref.ref };
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Shared reads
// ───────────────────────────────────────────────────────────────────────────

async function childrenOf(
  ctx: { db: QueryCtx["db"] },
  parentId: RowId,
  limit: number,
): Promise<Row[]> {
  return ctx.db
    .query("selectorOptions")
    .withIndex("by_parent", (q) => q.eq("parentId", parentId))
    .take(limit);
}

async function cardsOn(
  ctx: { db: QueryCtx["db"] },
  rowId: RowId,
  limit: number,
): Promise<Card[]> {
  return ctx.db
    .query("cardChecklist")
    .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", rowId))
    .take(limit);
}

/**
 * Staged checklist review on a row — the in-flight work the trash icon also
 * refuses to delete under (NEO-219 security condition 2). Checked up front
 * so the operator gets a sentence rather than the delete helper's holdings.
 */
async function hasOpenReview(
  ctx: { db: QueryCtx["db"] },
  rowId: RowId,
): Promise<boolean> {
  const staged = await ctx.db
    .query("checklistCandidates")
    .withIndex("by_selector_option_and_user", (q) =>
      q.eq("selectorOptionId", rowId),
    )
    .first();
  if (staged) return true;
  const queued = await ctx.db
    .query("entityReviewQueue")
    .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", rowId))
    .first();
  return queued !== null;
}

/** The first variant type under `setId` whose NB role is "parallel". */
async function parallelTypeOf(
  ctx: { db: QueryCtx["db"] },
  setId: RowId,
): Promise<Row | null> {
  const types = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "variantType").eq("parentId", setId),
    )
    .collect();
  return types.find((t) => variantTypeRole(t) === "parallel") ?? null;
}

// ───────────────────────────────────────────────────────────────────────────
// Card move (shared by both doors)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Re-parent `moves` onto `destId`, each card with its own slot map, and put
 * them in card-number order.
 *
 * An EMPTY destination gets `sortOrder` 0..n-1 in `compareCardNumbers` order
 * in the same patch that moves each card, so nothing else is written. A
 * destination that already holds cards gets the moved ones appended after
 * its highest `sortOrder`, and the existing restamp chain is scheduled to
 * interleave them — the house shape for a re-number that may exceed one
 * transaction (`restampCardChecklistSortOrdersBatch`). The only field that
 * chain writes is `sortOrder`, so its worst case is a display-order wobble.
 */
async function moveCards(
  ctx: MutationCtx,
  destId: RowId,
  moves: ReadonlyArray<{
    card: Card;
    slotMap: Partial<Record<PlatformSide, ReadonlyMap<string, string>>>;
  }>,
  now: number,
): Promise<void> {
  if (moves.length === 0) return;
  const existing = await ctx.db
    .query("cardChecklist")
    .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", destId))
    .take(1);
  const ordered = [...moves].sort((a, b) =>
    compareCardNumbers(a.card.cardNumber, b.card.cardNumber),
  );
  let base = 0;
  if (existing.length > 0) {
    // The highest sortOrder on the destination, read in full: `take(1)` above
    // only answered "is it empty?".
    const all = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", destId))
      .collect();
    base = all.reduce((max, c) => Math.max(max, c.sortOrder), -1) + 1;
  }
  for (let i = 0; i < ordered.length; i++) {
    const { card, slotMap } = ordered[i];
    await ctx.db.patch(card._id, {
      selectorOptionId: destId,
      platformData: remapCardPlatformData(card.platformData, slotMap),
      sortOrder: base + i,
      lastUpdated: now,
    });
  }
  if (existing.length > 0) {
    await ctx.scheduler.runAfter(
      0,
      internal.selectorOptions.restampCardChecklistSortOrdersBatch,
      { selectorOptionId: destId, from: 0, pagesLeft: RESTAMP_MAX_PAGES },
    );
  }
}

/**
 * Carry NEO-21 guest cross-listings from a row that is about to be deleted
 * onto `destId`. A link whose card now LIVES on the destination, or that the
 * destination already lists, is redundant and is deleted rather than
 * duplicated; every other link is re-pointed. Nothing about the card changes.
 */
async function moveGuestCrossListings(
  ctx: MutationCtx,
  links: ReadonlyArray<Doc<"cardCrossListings">>,
  destId: RowId,
  now: number,
): Promise<void> {
  if (links.length === 0) return;
  const destLinks = await ctx.db
    .query("cardCrossListings")
    .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", destId))
    .collect();
  const listed = new Set<string>(destLinks.map((l) => l.cardChecklistId));
  for (const link of links) {
    const card = await ctx.db.get(link.cardChecklistId);
    if (!card || card.selectorOptionId === destId || listed.has(link.cardChecklistId)) {
      await ctx.db.delete(link._id);
      continue;
    }
    listed.add(link.cardChecklistId);
    await ctx.db.patch(link._id, { selectorOptionId: destId, lastUpdated: now });
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Part B — "Make parallel of…"
// ───────────────────────────────────────────────────────────────────────────

type ConversionSource =
  | { ok: false; reason: string }
  | {
      ok: true;
      set: Row;
      base: Row;
      brand: Row;
    };

/**
 * Every guard that depends on the SOURCE set alone — the ones the row action
 * is shown or hidden by. Reads a handful of rows: the set, at most two of its
 * children, at most one of the Base's, the brand. The review and card checks
 * are the mutation's; the eligibility query does not need them to decide
 * whether to offer the door.
 */
async function readConversionSource(
  ctx: { db: QueryCtx["db"] },
  setId: RowId,
): Promise<ConversionSource> {
  const set = await ctx.db.get(setId);
  if (!set) return { ok: false, reason: conversionRefusal.setGone() };
  if (set.level !== "setName") {
    return { ok: false, reason: conversionRefusal.notASet() };
  }
  if (slotIds(set, "bsc").length > 0) {
    return { ok: false, reason: conversionRefusal.onBsc(set.value) };
  }
  const children = await childrenOf(ctx, set._id, 2);
  if (children.length === 0) {
    return { ok: false, reason: conversionRefusal.noBase(set.value) };
  }
  const base = children[0];
  if (
    children.length > 1 ||
    base.level !== "variantType" ||
    base.metadata?.isBase !== true
  ) {
    return { ok: false, reason: conversionRefusal.moreThanBase(set.value) };
  }
  if (slotIds(base, "bsc").length > 0) {
    return { ok: false, reason: conversionRefusal.onBsc(set.value) };
  }
  if ((await childrenOf(ctx, base._id, 1)).length > 0) {
    return { ok: false, reason: conversionRefusal.baseHasRows(set.value) };
  }
  const brand = set.parentId ? await ctx.db.get(set.parentId) : null;
  if (!brand || brand.level !== "manufacturer") {
    return { ok: false, reason: conversionRefusal.setGone() };
  }
  return { ok: true, set, base, brand };
}

/**
 * The SportLots links a convert carries, Base first (its primary leading),
 * then any the set row itself holds. Each entry names the row and slot it
 * leaves, so every card's `src` can be remapped by the row it sits on.
 */
function linksToMove(
  set: Row,
  base: Row,
): Array<{ from: RowId; slot: string; id: string; label: string }> {
  const out: Array<{ from: RowId; slot: string; id: string; label: string }> = [];
  for (const row of [base, set]) {
    const primary = primarySlot(row, "sportlots");
    const entries = slotEntries(row, "sportlots").sort((a, b) =>
      a.slot === primary ? -1 : b.slot === primary ? 1 : 0,
    );
    for (const { slot, id } of entries) {
      out.push({ from: row._id, slot, id, label: slotLabel(row, "sportlots", slot) });
    }
  }
  return out;
}

/**
 * The label a new parallel is named from: the Base's primary SportLots label,
 * or — for a set carrying no SportLots link at all, which behaves the same
 * way (invariant 6) — the set's own NB name.
 */
function namingLabel(set: Row, base: Row): string {
  const links = linksToMove(set, base);
  return links[0]?.label ?? set.value;
}

type TargetResolution =
  | { ok: false; reason: string }
  | { ok: true; targetType: Row; targetSet: Row };

async function resolveTarget(
  ctx: { db: QueryCtx["db"] },
  source: { set: Row; brand: Row },
  targetParallelTypeId: RowId,
): Promise<TargetResolution> {
  const targetType = await ctx.db.get(targetParallelTypeId);
  if (!targetType || targetType.level !== "variantType" || !targetType.parentId) {
    return { ok: false, reason: conversionRefusal.targetGone() };
  }
  if (targetType.parentId === source.set._id) {
    return { ok: false, reason: conversionRefusal.self(source.set.value) };
  }
  const targetSet = await ctx.db.get(targetType.parentId);
  if (!targetSet || targetSet.level !== "setName") {
    return { ok: false, reason: conversionRefusal.targetGone() };
  }
  if (targetSet._id === source.set._id) {
    return { ok: false, reason: conversionRefusal.self(source.set.value) };
  }
  // Same brand is same year: a brand row belongs to exactly one year.
  if (targetSet.parentId !== source.brand._id) {
    return {
      ok: false,
      reason: conversionRefusal.otherBrand(targetSet.value, source.brand.value),
    };
  }
  if (variantTypeRole(targetType) !== "parallel") {
    return {
      ok: false,
      reason: conversionRefusal.notParallelType(targetType.value, targetSet.value),
    };
  }
  return { ok: true, targetType, targetSet };
}

/**
 * Would a NEW parallel be allowed under `targetType`, and what is it called?
 * The same checks the mutation makes, shared so the dialog can disable the
 * choice with the mutation's own sentence.
 */
function newParallelCheck(
  source: { set: Row; base: Row; brand: Row },
  targetSet: Row,
  siblings: ReadonlyArray<Row>,
):
  | { ok: true; name: string }
  | { ok: false; reason: string; name: string | null; sameAs?: RowId } {
  const label = namingLabel(source.set, source.base);
  const derived = parallelNameFromLabel(
    label,
    targetSet.value,
    source.brand.metadata?.setNamePrefix,
  );
  if (derived === null) {
    return {
      ok: false,
      reason: conversionRefusal.ownName(label, targetSet.value),
      name: null,
    };
  }
  const checked = checkCustomSelectorValue("insert", derived);
  if (!checked.ok) {
    return { ok: false, reason: conversionRefusal.badName(checked.reason), name: derived };
  }
  const key = selectorValueKey(checked.value);
  const clash = siblings.find((s) => selectorValueKey(s.value) === key);
  if (clash) {
    return {
      ok: false,
      reason: conversionRefusal.nameTaken(targetSet.value, clash.value),
      name: checked.value,
      sameAs: clash._id,
    };
  }
  const holder = siblings.find((s) => holdsAnyLink(s, source));
  if (holder) {
    // No `sameAs`: adding to the holder is refused for the same reason.
    return {
      ok: false,
      reason: conversionRefusal.linkTaken(targetSet.value, holder.value, source.set.value),
      name: checked.value,
    };
  }
  return { ok: true, name: checked.value };
}

/** Does `row` already hold any SportLots id the convert would move? By id. */
function holdsAnyLink(row: Row, source: { set: Row; base: Row }): boolean {
  const moving = new Set(linksToMove(source.set, source.base).map((l) => l.id));
  return slotIds(row, "sportlots").some((id) => moving.has(id));
}

async function parallelsUnder(
  ctx: { db: QueryCtx["db"] },
  typeId: RowId,
): Promise<Row[]> {
  return ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "insert").eq("parentId", typeId),
    )
    .collect();
}

/**
 * Whether the "Make parallel of…" row action is offered on a set. Only the
 * source-side guards: which target the operator picks is the dialog's
 * question, and the mutation re-checks everything.
 */
export const getSetToParallelEligibility = query({
  args: { setId: v.id("selectorOptions") },
  returns: v.object({ eligible: v.boolean() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await readConversionSource(ctx, args.setId);
    return { eligible: source.ok };
  },
});

const targetSetValidator = v.object({
  setId: v.id("selectorOptions"),
  value: v.string(),
  /** Absent when the set has no Parallel type yet. */
  parallelTypeId: v.optional(v.id("selectorOptions")),
  parallelTypeValue: v.optional(v.string()),
});

/**
 * The dialog's first read: the brand's other sets, each with its Parallel
 * type when it has one, and which one to preselect. Asked only while the
 * dialog is open.
 *
 * The preselection is a DISPLAY default over NB names (the set whose name is
 * the longest whole-word prefix of this one's, among sets that can take a
 * parallel) — never a decision the server acts on.
 */
export const getSetToParallelTargets = query({
  args: { setId: v.id("selectorOptions") },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({
      ok: v.literal(true),
      setValue: v.string(),
      brandValue: v.string(),
      cardCount: v.number(),
      targets: v.array(targetSetValidator),
      suggestedSetId: v.optional(v.id("selectorOptions")),
      truncated: v.boolean(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await readConversionSource(ctx, args.setId);
    if (!source.ok) return { ok: false as const, reason: source.reason };
    const { set, base, brand } = source;

    const siblings = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", brand._id),
      )
      .take(MAX_TARGET_SETS + 2);
    const others = siblings.filter((s) => s._id !== set._id);
    const truncated = others.length > MAX_TARGET_SETS;
    const listed = others
      .slice(0, MAX_TARGET_SETS)
      .sort((a, b) => a.value.localeCompare(b.value));

    const targets = [];
    for (const target of listed) {
      const type = await parallelTypeOf(ctx, target._id);
      targets.push({
        setId: target._id,
        value: target.value,
        ...(type ? { parallelTypeId: type._id, parallelTypeValue: type.value } : {}),
      });
    }

    let suggestedSetId: RowId | undefined;
    let longest = -1;
    for (const t of targets) {
      if (!t.parallelTypeId) continue;
      if (matchesBrandPrefix(set.value, t.value) && t.value.length > longest) {
        longest = t.value.length;
        suggestedSetId = t.setId;
      }
    }
    suggestedSetId ??= targets.find((t) => t.parallelTypeId)?.setId;

    const cards =
      (await cardsOn(ctx, base._id, MAX_CARDS_PER_MOVE + 1)).length +
      (await cardsOn(ctx, set._id, MAX_CARDS_PER_MOVE + 1)).length;

    return {
      ok: true as const,
      setValue: set.value,
      brandValue: brand.value,
      cardCount: cards,
      targets,
      ...(suggestedSetId ? { suggestedSetId } : {}),
      truncated,
    };
  },
});

/** What `getSetToParallelTargetDetail` answers; mirrors its validator. */
type TargetDetail =
  | { ok: false; reason: string }
  | {
      ok: true;
      targetSetValue: string;
      parallelTypeId: RowId;
      parallelTypeValue: string;
      parallels: Array<{ _id: RowId; value: string; holdsLink: boolean }>;
      holdsLinkReason?: string;
      newName?: string;
      newRefusal?: string;
      sameAsId?: RowId;
    };

/**
 * The dialog's second read, for the target set the operator has picked: its
 * Parallel type, the parallels already under it, and what a new one would be
 * called — or, when a new one is not allowed, the mutation's own sentence and
 * the parallel to add to instead.
 */
export const getSetToParallelTargetDetail = query({
  args: {
    setId: v.id("selectorOptions"),
    targetSetId: v.id("selectorOptions"),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({
      ok: v.literal(true),
      targetSetValue: v.string(),
      parallelTypeId: v.id("selectorOptions"),
      parallelTypeValue: v.string(),
      parallels: v.array(
        v.object({
          _id: v.id("selectorOptions"),
          value: v.string(),
          /**
           * Already holds one of the links this set would bring. Not a
           * destination in either mode; `holdsLinkReason` says why.
           */
          holdsLink: v.boolean(),
        }),
      ),
      /** The sentence for a parallel that `holdsLink`. */
      holdsLinkReason: v.optional(v.string()),
      /** The new parallel's name, when one can be made. */
      newName: v.optional(v.string()),
      /** Why a new parallel cannot be made, when it cannot. */
      newRefusal: v.optional(v.string()),
      /** The existing parallel the refusal points at, to preselect. */
      sameAsId: v.optional(v.id("selectorOptions")),
    }),
  ),
  handler: async (ctx, args): Promise<TargetDetail> => {
    await requireAdmin(ctx);
    const source = await readConversionSource(ctx, args.setId);
    if (!source.ok) return { ok: false as const, reason: source.reason };
    const targetSet = await ctx.db.get(args.targetSetId);
    if (!targetSet || targetSet.level !== "setName") {
      return { ok: false as const, reason: conversionRefusal.targetGone() };
    }
    if (targetSet._id === source.set._id) {
      return { ok: false as const, reason: conversionRefusal.self(source.set.value) };
    }
    if (targetSet.parentId !== source.brand._id) {
      return {
        ok: false as const,
        reason: conversionRefusal.otherBrand(targetSet.value, source.brand.value),
      };
    }
    const type = await parallelTypeOf(ctx, targetSet._id);
    if (!type) {
      return {
        ok: false as const,
        reason: noParallelTypeYet(targetSet.value),
      };
    }
    const parallels = (await parallelsUnder(ctx, type._id)).sort((a, b) =>
      a.value.localeCompare(b.value),
    );
    const check = newParallelCheck(source, targetSet, parallels);
    const holder = parallels.find((p) => holdsAnyLink(p, source));
    return {
      ok: true as const,
      targetSetValue: targetSet.value,
      parallelTypeId: type._id,
      parallelTypeValue: type.value,
      parallels: parallels.map((p) => ({
        _id: p._id,
        value: p.value,
        holdsLink: holdsAnyLink(p, source),
      })),
      ...(holder
        ? {
            holdsLinkReason: conversionRefusal.linkTaken(
              targetSet.value,
              holder.value,
              source.set.value,
            ),
          }
        : {}),
      ...(check.ok
        ? { newName: check.name }
        : {
            newRefusal: check.reason,
            ...(check.sameAs ? { sameAsId: check.sameAs } : {}),
          }),
    };
  },
});

/** DRAFT copy: a target set with no Parallel variant type yet. */
export const noParallelTypeYet = (target: string): string =>
  `${target} has no Parallel type yet. Pick ${target}, run Sync Variant Types, then come back.`;

/**
 * NEO-305 Part B — "Make parallel of…".
 *
 * A set that is nothing but a Base holding SportLots links (the shape
 * `insertSetWithBaseFromSl` mints) becomes a parallel of another set in the
 * same brand: every SportLots link on the Base (and on the set row, if it
 * carries any) moves — id and label — onto `attachToId`, an existing
 * insert-level row under the target's Parallel type, or onto a new one
 * named by `parallelNameFromLabel` with flags from `derivedVariantFlags`.
 * The cards follow their own links; guest cross-listings follow the row.
 * The emptied Base and set are then deleted through the trash icon's own
 * helper, in this same transaction, so a row that is not in fact empty
 * refuses and nothing lands.
 */
export const convertSetToParallel = mutation({
  args: {
    setId: v.id("selectorOptions"),
    targetParallelTypeId: v.id("selectorOptions"),
    attachToId: v.optional(v.id("selectorOptions")),
  },
  returns: v.object({
    targetSetId: v.id("selectorOptions"),
    parallelTypeId: v.id("selectorOptions"),
    parallelId: v.id("selectorOptions"),
    parallelValue: v.string(),
    targetSetValue: v.string(),
    created: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const adminUserId = await requireAdmin(ctx);
    const source = await readConversionSource(ctx, args.setId);
    if (!source.ok) throw new ConvexError(source.reason);
    const { set, base, brand } = source;

    const resolved = await resolveTarget(ctx, source, args.targetParallelTypeId);
    if (!resolved.ok) throw new ConvexError(resolved.reason);
    const { targetType, targetSet } = resolved;

    if ((await hasOpenReview(ctx, base._id)) || (await hasOpenReview(ctx, set._id))) {
      throw new ConvexError(conversionRefusal.reviewOpen(set.value));
    }

    // Cards, bounded before anything is written.
    const baseCards = await cardsOn(ctx, base._id, MAX_CARDS_PER_MOVE + 1);
    const setCards = await cardsOn(ctx, set._id, MAX_CARDS_PER_MOVE + 1);
    if (baseCards.length + setCards.length > MAX_CARDS_PER_MOVE) {
      throw new ConvexError(conversionRefusal.tooManyCards(set.value, MAX_CARDS_PER_MOVE));
    }
    const guestLinks = [];
    for (const rowId of [base._id, set._id]) {
      guestLinks.push(
        ...(await ctx.db
          .query("cardCrossListings")
          .withIndex("by_selector_option", (q) => q.eq("selectorOptionId", rowId))
          .take(MAX_CROSS_LISTINGS_PER_MOVE + 1)),
      );
    }
    if (guestLinks.length > MAX_CROSS_LISTINGS_PER_MOVE) {
      throw new ConvexError(
        conversionRefusal.tooManyGuests(set.value, MAX_CROSS_LISTINGS_PER_MOVE),
      );
    }

    const links = linksToMove(set, base);
    const now = Date.now();

    // ── the destination row and its slots ──────────────────────────────
    let dest: Row;
    let created: boolean;
    let slotByIdOnDest: Record<string, string>;
    if (args.attachToId) {
      const attach = await ctx.db.get(args.attachToId);
      if (!attach || attach.level !== "insert" || attach.parentId !== targetType._id) {
        throw new ConvexError(conversionRefusal.attachGone());
      }
      if (holdsAnyLink(attach, source)) {
        throw new ConvexError(
          conversionRefusal.linkTaken(targetSet.value, attach.value, set.value),
        );
      }
      const alloc = allocateSlots(attach, {
        sportlots: links.map((l) => ({ id: l.id, label: l.label })),
      });
      await ctx.db.patch(attach._id, {
        platformData: alloc.platformData,
        platformLabels: alloc.platformLabels,
        platformSlotSeq: alloc.platformSlotSeq,
        lastUpdated: now,
      });
      dest = attach;
      created = false;
      slotByIdOnDest = alloc.slotByIdBySide.sportlots;
    } else {
      const siblings = await parallelsUnder(ctx, targetType._id);
      const check = newParallelCheck(source, targetSet, siblings);
      if (!check.ok) throw new ConvexError(check.reason);
      const flags = derivedVariantFlags("insert", targetType);
      const features = {
        ...(targetType.features ?? {}),
        ...deriveOwnLevelFeatures("insert", check.name, flags),
      };
      const teamIds = inheritedTeamIds(targetType);
      const alloc = initialSlots({
        sportlots: links.map((l) => ({ id: l.id, label: l.label })),
      });
      const destId = await ctx.db.insert("selectorOptions", {
        level: "insert",
        value: check.name,
        platformData: alloc.platformData,
        platformLabels: alloc.platformLabels,
        platformSlotSeq: alloc.platformSlotSeq,
        parentId: targetType._id,
        children: [],
        createdByUserId: adminUserId,
        ...(flags ? { metadata: flags } : {}),
        ...(Object.keys(features).length > 0 ? { features } : {}),
        ...(teamIds ? { teamIds } : {}),
        lastUpdated: now,
      });
      await ctx.db.patch(targetType._id, {
        children: unionChildren(targetType.children, [destId]),
      });
      dest = (await ctx.db.get(destId))!;
      created = true;
      slotByIdOnDest = alloc.slotByIdBySide.sportlots;
    }

    // ── cards follow their own links ──────────────────────────────────
    const slotMapFor = (rowId: RowId): Map<string, string> => {
      const map = new Map<string, string>();
      for (const l of links) {
        if (l.from !== rowId) continue;
        const destSlot = slotByIdOnDest[l.id];
        if (destSlot) map.set(l.slot, destSlot);
      }
      return map;
    };
    const baseMap = slotMapFor(base._id);
    const setMap = slotMapFor(set._id);
    await moveCards(
      ctx,
      dest._id,
      [
        // BSC: the source carries no BSC slot (guarded above), so every BSC
        // `src` on these cards is already dangling and is cleared, ref kept.
        ...baseCards.map((card) => ({ card, slotMap: { sportlots: baseMap } })),
        ...setCards.map((card) => ({ card, slotMap: { sportlots: setMap } })),
      ],
      now,
    );
    await moveGuestCrossListings(ctx, guestLinks, dest._id, now);

    // ── end the emptied rows through the trash icon's own helper ──────
    await deleteEmptySelectorOptionRow(ctx, (await ctx.db.get(base._id))!, adminUserId);
    await deleteEmptySelectorOptionRow(ctx, (await ctx.db.get(set._id))!, adminUserId);

    console.log(
      JSON.stringify({
        msg: "set_converted_to_parallel",
        adminUserId,
        setId: set._id,
        baseId: base._id,
        destId: dest._id,
        created,
        links: links.length,
        cards: baseCards.length + setCards.length,
        guests: guestLinks.length,
      }),
    );

    return {
      targetSetId: targetSet._id,
      parallelTypeId: targetType._id,
      parallelId: dest._id,
      parallelValue: dest.value,
      targetSetValue: targetSet.value,
      created,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// Part C — "Promote to set"
// ───────────────────────────────────────────────────────────────────────────

type PromotionSource =
  | { ok: false; reason: string }
  | { ok: true; row: Row; set: Row; brand: Row };

/**
 * A parallel of a set: an `insert`-level row under a variant type whose NB
 * role is "parallel" — or, when that role cannot be read any more (the type
 * lost its tagged BSC slot), a row that was born flagged `isParallel`. Both
 * are NB facts about the row, never its name.
 */
async function readPromotionSource(
  ctx: { db: QueryCtx["db"] },
  parallelId: RowId,
): Promise<PromotionSource> {
  const row = await ctx.db.get(parallelId);
  if (!row) return { ok: false, reason: promotionRefusal.rowGone() };
  const type = row.parentId ? await ctx.db.get(row.parentId) : null;
  if (
    row.level !== "insert" ||
    !type ||
    type.level !== "variantType" ||
    (variantTypeRole(type) !== "parallel" && row.metadata?.isParallel !== true)
  ) {
    return { ok: false, reason: promotionRefusal.notAParallel(row.value) };
  }
  const set = type.parentId ? await ctx.db.get(type.parentId) : null;
  const brand = set?.parentId ? await ctx.db.get(set.parentId) : null;
  if (!set || set.level !== "setName" || !brand || brand.level !== "manufacturer") {
    return { ok: false, reason: promotionRefusal.noBrand() };
  }
  return { ok: true, row, set, brand };
}

/** The Base of a set: its variant type carrying the NB base role. */
async function baseOf(
  ctx: { db: QueryCtx["db"] },
  setId: RowId,
): Promise<Row | null> {
  const types = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "variantType").eq("parentId", setId),
    )
    .collect();
  return types.find((t) => t.metadata?.isBase === true) ?? null;
}

/**
 * The cards a promote carries: exactly those whose SportLots ref is
 * attributed to `slot` on the parallel. A card also carrying a BSC ref
 * attributed to a slot that STAYS on the row is paired across the split and
 * is counted, never moved — the caller refuses on any.
 */
function splitCardsForSlot(
  row: Row,
  cards: ReadonlyArray<Card>,
  slot: string,
): { moving: Card[]; paired: number } {
  const moving: Card[] = [];
  let paired = 0;
  for (const card of cards) {
    if (card.platformData.sportlots?.src !== slot) continue;
    const bscSrc = card.platformData.bsc?.src;
    if (bscSrc !== undefined && idForSlot(row, "bsc", bscSrc) !== undefined) {
      paired++;
      continue;
    }
    moving.push(card);
  }
  return { moving, paired };
}

/** The brand's sets folded by name, bounded like the sync's year index. */
async function brandSetsByKey(
  ctx: { db: QueryCtx["db"] },
  brandId: RowId,
): Promise<{ byKey: Map<string, Row>; truncated: boolean }> {
  const rows = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "setName").eq("parentId", brandId),
    )
    .take(MAX_YEAR_SET_ROWS + 1);
  const byKey = new Map<string, Row>();
  for (const r of rows.slice(0, MAX_YEAR_SET_ROWS)) {
    const key = selectorValueKey(r.value);
    if (!byKey.has(key)) byKey.set(key, r);
  }
  return { byKey, truncated: rows.length > MAX_YEAR_SET_ROWS };
}

/**
 * Whether "Promote to set" is offered on a row, and which SportLots links it
 * can promote (each with its label, for the picker when there are several).
 */
export const getParallelPromotionEligibility = query({
  args: { parallelId: v.id("selectorOptions") },
  returns: v.union(
    v.object({ eligible: v.literal(false) }),
    v.object({
      eligible: v.literal(true),
      links: v.array(v.object({ slot: v.string(), label: v.string() })),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await readPromotionSource(ctx, args.parallelId);
    if (!source.ok) return { eligible: false as const };
    const links = slotEntries(source.row, "sportlots").map(({ slot }) => ({
      slot,
      label: slotLabel(source.row, "sportlots", slot),
    }));
    if (links.length === 0) return { eligible: false as const };
    return { eligible: true as const, links };
  },
});

/**
 * The dialog's read for one link: the set it would become, and whether that
 * name is already a set in the brand (the dialog then offers "add to that
 * set's Base"). Asked only while the dialog is open.
 */
export const getParallelPromotionPreview = query({
  args: {
    parallelId: v.id("selectorOptions"),
    slSlotKey: v.string(),
  },
  returns: v.union(
    v.object({ ok: v.literal(false), reason: v.string() }),
    v.object({
      ok: v.literal(true),
      rowValue: v.string(),
      brandValue: v.string(),
      setName: v.string(),
      cardCount: v.number(),
      /** The row stays: something is left on it after the link goes. */
      rowStays: v.boolean(),
      clash: v.optional(
        v.object({
          setId: v.id("selectorOptions"),
          value: v.string(),
          hasBase: v.boolean(),
          /** That set's Base already holds the link; adding is refused too. */
          holdsLink: v.boolean(),
        }),
      ),
      /** Why the promote would refuse, when it would regardless of choice. */
      refusal: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const source = await readPromotionSource(ctx, args.parallelId);
    if (!source.ok) return { ok: false as const, reason: source.reason };
    const { row, brand } = source;
    const id = idForSlot(row, "sportlots", args.slSlotKey);
    if (id === undefined) {
      return { ok: false as const, reason: promotionRefusal.linkGone(row.value) };
    }
    const label = slotLabel(row, "sportlots", args.slSlotKey);
    const { defaultName } = candidateDefaultName(label, brand.metadata?.setNamePrefix);

    const cards = await cardsOn(ctx, row._id, MAX_CARDS_PER_ROW_READ + 1);
    const { moving, paired } = splitCardsForSlot(row, cards, args.slSlotKey);
    const leftOnRow =
      slotIds(row, "bsc").length > 0 ||
      slotIds(row, "sportlots").length > 1 ||
      cards.length > moving.length ||
      (await childrenOf(ctx, row._id, 1)).length > 0;

    let refusal: string | undefined;
    if (paired > 0) refusal = promotionRefusal.paired(row.value, paired);
    else if (moving.length > MAX_CARDS_PER_MOVE || cards.length > MAX_CARDS_PER_ROW_READ) {
      refusal = promotionRefusal.tooManyCards(row.value, MAX_CARDS_PER_MOVE);
    }

    const checked = checkCustomSelectorValue("setName", defaultName);
    let clash:
      | { setId: RowId; value: string; hasBase: boolean; holdsLink: boolean }
      | undefined;
    if (checked.ok) {
      const { byKey, truncated } = await brandSetsByKey(ctx, brand._id);
      if (truncated) refusal ??= promotionRefusal.tooManySets(brand.value);
      const hit = byKey.get(selectorValueKey(checked.value));
      if (hit) {
        const hitBase = await baseOf(ctx, hit._id);
        clash = {
          setId: hit._id,
          value: hit.value,
          hasBase: hitBase !== null,
          holdsLink: hitBase ? slotIds(hitBase, "sportlots").includes(id) : false,
        };
      }
    } else {
      refusal ??= promotionRefusal.badName(checked.reason);
    }

    return {
      ok: true as const,
      rowValue: row.value,
      brandValue: brand.value,
      setName: checked.ok ? checked.value : defaultName,
      cardCount: moving.length,
      rowStays: leftOnRow,
      ...(clash ? { clash } : {}),
      ...(refusal ? { refusal } : {}),
    };
  },
});

/**
 * NEO-305 Part C — "Promote to set", the way back from Part B.
 *
 * One SportLots link (`slSlotKey`) on a parallel row becomes a set under the
 * same brand: a set and Base minted by `insertSetWithBaseFromSl` — the exact
 * shape the Sync Sets SportLots phase writes — named by
 * `candidateDefaultName`, the Base holding the link with its id and label.
 * With `attachToSetId` the link goes onto that set's Base instead (the
 * answer to a name clash). The cards attributed to the link move with it.
 *
 * The link leaves the parallel. The row itself is deleted only when nothing
 * is left on it — no link on either marketplace, no card, no row under it,
 * nothing listed in it — so a row still holding a BSC link stays as BSC's
 * parallel. Links are never dropped in either direction.
 */
export const promoteParallelToSet = mutation({
  args: {
    parallelId: v.id("selectorOptions"),
    slSlotKey: v.string(),
    attachToSetId: v.optional(v.id("selectorOptions")),
  },
  returns: v.object({
    setId: v.id("selectorOptions"),
    baseId: v.id("selectorOptions"),
    setValue: v.string(),
    created: v.boolean(),
    parallelKept: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const adminUserId = await requireAdmin(ctx);
    const source = await readPromotionSource(ctx, args.parallelId);
    if (!source.ok) throw new ConvexError(source.reason);
    const { row, brand } = source;

    const id = idForSlot(row, "sportlots", args.slSlotKey);
    if (id === undefined) {
      throw new ConvexError(promotionRefusal.linkGone(row.value));
    }
    const label = slotLabel(row, "sportlots", args.slSlotKey);

    if (await hasOpenReview(ctx, row._id)) {
      throw new ConvexError(promotionRefusal.reviewOpen(row.value));
    }
    // Read past the move bound so the link's share can be counted: a row
    // holding cards for several links may hold more than one move carries in
    // total. Beyond this read the split cannot be judged at all, so it
    // refuses rather than leave cards behind on a link that has gone.
    const cards = await cardsOn(ctx, row._id, MAX_CARDS_PER_ROW_READ + 1);
    if (cards.length > MAX_CARDS_PER_ROW_READ) {
      throw new ConvexError(promotionRefusal.tooManyCards(row.value, MAX_CARDS_PER_MOVE));
    }
    const { moving, paired } = splitCardsForSlot(row, cards, args.slSlotKey);
    if (paired > 0) throw new ConvexError(promotionRefusal.paired(row.value, paired));
    if (moving.length > MAX_CARDS_PER_MOVE) {
      throw new ConvexError(promotionRefusal.tooManyCards(row.value, MAX_CARDS_PER_MOVE));
    }

    const now = Date.now();
    let setId: RowId;
    let setValue: string;
    let base: Row;
    let created: boolean;
    let destSlot: string;

    if (args.attachToSetId) {
      const target = await ctx.db.get(args.attachToSetId);
      if (!target || target.level !== "setName") {
        throw new ConvexError(promotionRefusal.attachGone());
      }
      if (target.parentId !== brand._id) {
        throw new ConvexError(promotionRefusal.attachOtherBrand(target.value, brand.value));
      }
      const targetBase = await baseOf(ctx, target._id);
      if (!targetBase) throw new ConvexError(promotionRefusal.attachNoBase(target.value));
      if (slotIds(targetBase, "sportlots").includes(id)) {
        throw new ConvexError(promotionRefusal.linkTaken(target.value, row.value));
      }
      const alloc = allocateSlots(targetBase, { sportlots: [{ id, label }] });
      await ctx.db.patch(targetBase._id, {
        platformData: alloc.platformData,
        platformLabels: alloc.platformLabels,
        platformSlotSeq: alloc.platformSlotSeq,
        lastUpdated: now,
      });
      setId = target._id;
      setValue = target.value;
      base = targetBase;
      created = false;
      destSlot = alloc.slotByIdBySide.sportlots[id];
    } else {
      const { defaultName } = candidateDefaultName(label, brand.metadata?.setNamePrefix);
      const { byKey, truncated } = await brandSetsByKey(ctx, brand._id);
      if (truncated) throw new ConvexError(promotionRefusal.tooManySets(brand.value));
      const clash = byKey.get(selectorValueKey(defaultName.trim()));
      if (clash) {
        throw new ConvexError(promotionRefusal.nameTaken(brand.value, clash.value));
      }
      const minted = await insertSetWithBaseFromSl(ctx, {
        brandId: brand._id,
        name: defaultName,
        sl: { id, label },
        createdByUserId: adminUserId,
      });
      if (!minted.ok) {
        switch (minted.reason) {
          case "clash_at_target":
            throw new ConvexError(promotionRefusal.nameTaken(brand.value, minted.value));
          case "exists_elsewhere":
            throw new ConvexError(
              promotionRefusal.existsElsewhere(
                minted.matches[0].value,
                minted.matches[0].brand,
                brand.value,
              ),
            );
          case "invalid_name":
            throw new ConvexError(promotionRefusal.badName(minted.detail));
          case "brand_missing":
          case "index_truncated":
            throw new ConvexError(promotionRefusal.noBrand());
        }
      }
      const fresh = (await ctx.db.get(minted.baseId))!;
      setId = minted.setId;
      setValue = (await ctx.db.get(minted.setId))!.value;
      base = fresh;
      created = true;
      destSlot = slotForId(fresh, "sportlots", id)!;
    }

    // ── the cards attributed to the link follow it ─────────────────────
    await moveCards(
      ctx,
      base._id,
      moving.map((card) => ({
        card,
        slotMap: { sportlots: new Map([[args.slSlotKey, destSlot]]) },
      })),
      now,
    );

    // ── the link leaves the parallel ───────────────────────────────────
    const detached = detachSlot(row, "sportlots", args.slSlotKey);
    const primary = { ...(row.primaryPlatformId ?? {}) };
    if (primary.sportlots === args.slSlotKey) delete primary.sportlots;
    await ctx.db.patch(row._id, {
      platformData: detached.platformData,
      platformLabels: detached.platformLabels,
      primaryPlatformId: Object.keys(primary).length > 0 ? primary : undefined,
      lastUpdated: now,
    });

    // ── and the row goes only when nothing is left on it ────────────────
    const after = (await ctx.db.get(row._id))!;
    const linked =
      slotIds(after, "bsc").length > 0 || slotIds(after, "sportlots").length > 0;
    const holds = linked ? [] : await collectSelectorOptionHoldings(ctx, after);
    const parallelKept = linked || holds.length > 0;
    if (!parallelKept) {
      await deleteEmptySelectorOptionRow(ctx, after, adminUserId);
    }

    console.log(
      JSON.stringify({
        msg: "parallel_promoted_to_set",
        adminUserId,
        parallelId: row._id,
        setId,
        baseId: base._id,
        created,
        parallelKept,
        cards: moving.length,
      }),
    );

    return { setId, baseId: base._id, setValue, created, parallelKept };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// The Parallels sync's filter (coordinator, NEO-305)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Rows one brand walk reads before it stops and says so — the same ceiling
 * `listBrandSubtreeSlIds` walks a brand under (`MAX_SYNC_ITEMS`).
 */
export const MAX_BRAND_HOLDER_ROWS = 2000;

/**
 * Every row ELSEWHERE in a variant type's brand — under any set but its own —
 * that holds a SportLots link, with the NB name the operator knows it by.
 *
 * Why: a Parallels (or Inserts) sync asks SportLots for the brand's whole
 * list, and the forms only ever held back ids used within the SAME set
 * (`getUsedInsertIdentifiersBySet`). So "Bowman Blue", a set whose Base
 * already holds that SportLots id, came back as a fresh candidate for
 * Bowman's Parallels — and taking it put one SportLots id on two rows. The
 * form now holds these ids back exactly as it holds back a grouped parallel's
 * (NEO-300's `heldElsewhere`): not offered, not auto-matched, and named in a
 * note so the operator can fold the set in with "Make parallel of…".
 *
 * Keyed by id; the names are NB names, for display only. Bounded by
 * `MAX_BRAND_HOLDER_ROWS` rows read; `truncated` says the list is partial.
 */
export const getBrandSlHolders = query({
  args: { variantTypeId: v.id("selectorOptions") },
  returns: v.object({
    rows: v.array(
      v.object({
        key: v.string(),
        name: v.string(),
        sportlots: v.array(v.string()),
      }),
    ),
    truncated: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const empty = { rows: [], truncated: false };
    const type = await ctx.db.get(args.variantTypeId);
    const ownSet = type?.parentId ? await ctx.db.get(type.parentId) : null;
    const brand = ownSet?.parentId ? await ctx.db.get(ownSet.parentId) : null;
    if (!type || !ownSet || !brand || brand.level !== "manufacturer") return empty;

    const rows: Array<{ key: string; name: string; sportlots: string[] }> = [];
    let read = 0;
    const take = async (parentId: RowId) => {
      const remaining = MAX_BRAND_HOLDER_ROWS - read;
      if (remaining <= 0) return null;
      const children = await ctx.db
        .query("selectorOptions")
        .withIndex("by_parent", (q) => q.eq("parentId", parentId))
        .take(remaining + 1);
      if (children.length > remaining) return null;
      read += children.length;
      return children;
    };

    const sets = await take(brand._id);
    if (sets === null) return { rows, truncated: true };
    for (const set of sets) {
      if (set._id === ownSet._id || set.level !== "setName") continue;
      // Breadth-first under one set, naming each row by the set it is in.
      let frontier: Array<{ row: Row; name: string }> = [{ row: set, name: set.value }];
      while (frontier.length > 0) {
        const next: Array<{ row: Row; name: string }> = [];
        for (const { row, name } of frontier) {
          const ids = slotIds(row, "sportlots");
          if (ids.length > 0) rows.push({ key: String(row._id), name, sportlots: ids });
          if (row.level === "parallel") continue;
          const children = await take(row._id);
          if (children === null) return { rows, truncated: true };
          for (const child of children) {
            // A Base IS the set to an operator ("Bowman Blue"); any other
            // row reads as the set plus its own name ("Bowman Chrome Gold").
            const childName =
              child.level === "variantType" && child.metadata?.isBase === true
                ? set.value
                : `${set.value} ${child.value}`;
            next.push({ row: child, name: childName });
          }
        }
        frontier = next;
      }
    }
    return { rows, truncated: false };
  },
});
