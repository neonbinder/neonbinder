/**
 * Shared helpers for the operator doors that change a set's SHAPE by moving
 * its marketplace links, cards and operator data from one row to another:
 * "Make parallel of…" and "Promote to set" (NEO-305, `setParallelConversion.ts`)
 * and "Make insert of…" (NEO-306). Extracted so the rules below live in one
 * module and every door keeps them the same way. No Convex function is
 * registered here; the doors own their queries and mutations.
 *
 * ## The invariants every door built on this module keeps
 *
 *  - KEYED BY ID. A link moves as (marketplace id, label) and lands in a
 *    slot allocated on the destination (`allocateSlots` / `initialSlots`).
 *    Nothing reads a marketplace name to decide anything; the only names
 *    derived here are a new row's NB name, once, at creation (product
 *    invariant 2a).
 *  - A LINK IS NEVER DROPPED. Every marketplace id on the source ends up on
 *    the destination, with its label. A card's ref is never removed.
 *  - CARDS FOLLOW THEIR OWN SLOT. A card's `platformData.<side>.src` is
 *    remapped from the source row's slot key to the destination's. A `src`
 *    that pointed at nothing on the source (already dangling), or at a slot
 *    that stays behind, is cleared rather than carried: slot keys are per
 *    row, so a carried key would silently point at whatever the destination
 *    holds under it.
 *  - CARD NUMBERS ARE NEVER ASSUMED UNIQUE. Cards are moved by `_id` and
 *    attributed by slot. Two cards with one number both move, or both stay.
 *  - NEVER GUESS. A card that cannot be attributed by id to exactly one side
 *    of a split (it carries the moving SportLots link AND a live BSC link
 *    that stays behind) is counted, never moved; the caller refuses the whole
 *    move rather than choosing.
 */

import type { MutationCtx, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  idForSlot,
  primarySlot,
  slotEntries,
  slotIds,
  slotLabel,
  type PlatformSide,
} from "./platformSlots";
import { RESTAMP_MAX_PAGES } from "./selectorOptions";
import {
  matchesBrandPrefix,
  selectorValueKey,
  stripMatchedBrandPrefix,
} from "./selectorSyncMatch";
import { MAX_YEAR_SET_ROWS } from "./setFromMarketplace";
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

/** Sets a door's target picker lists for one brand. */
export const MAX_TARGET_SETS = 500;

// ───────────────────────────────────────────────────────────────────────────
// Pure helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * The NB name a new row is born with: `label` with the first of `prefixes`
 * that matches taken off the front (whole word, case-insensitive — the
 * `matchesBrandPrefix` rule). Prefixes are tried in order; a label that
 * matches none keeps its whole (trimmed) self.
 *
 * `null` when the label IS a matching prefix: that entry is the prefix's own
 * row, not a child of it. Derived once, at creation, and never re-read.
 */
export function nameAfterPrefixes(
  label: string,
  prefixes: ReadonlyArray<string>,
): string | null {
  const trimmed = label.trim();
  for (const raw of prefixes) {
    const prefix = raw.trim();
    if (!prefix || !matchesBrandPrefix(trimmed, prefix)) continue;
    const rest = stripMatchedBrandPrefix(trimmed, prefix);
    // `stripMatchedBrandPrefix` never strips to nothing — it hands the label
    // back whole — so an unchanged result after a MATCH means "all prefix".
    return rest === trimmed ? null : rest;
  }
  return trimmed;
}

/**
 * The prefixes a label under `targetSetValue` is named after: the target's
 * own name, then — because SportLots files some lists brand-stripped
 * ("Chrome Blue Refractor" under "Bowman Chrome") — the target's name
 * without its brand's set-name prefix, when that differs.
 */
export function targetNamePrefixes(
  targetSetValue: string,
  brandSetNamePrefix?: string,
): string[] {
  const prefixes = [targetSetValue.trim()];
  const brandPrefix = brandSetNamePrefix?.trim();
  if (brandPrefix && matchesBrandPrefix(targetSetValue, brandPrefix)) {
    const bare = stripMatchedBrandPrefix(targetSetValue, brandPrefix);
    if (bare !== targetSetValue.trim()) prefixes.push(bare);
  }
  return prefixes;
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

/** One SportLots link a move carries, and the row and slot it leaves. */
export type MovingLink = { from: RowId; slot: string; id: string; label: string };

/**
 * The SportLots links a move carries off `rows`, in the order given (callers
 * pass the child first: a set's Base before the set), each row's primary
 * leading its own. Each entry names the row and slot it leaves, so every
 * card's `src` can be remapped by the row it sits on.
 */
export function linksOnRows(rows: ReadonlyArray<Row>): MovingLink[] {
  const out: MovingLink[] = [];
  for (const row of rows) {
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
 * The label a new row is named from: the first moving link's label (the
 * first row's primary SportLots label), or — for rows carrying no SportLots
 * link at all, which behave the same way (invariant 6) — `fallback`, the
 * source's own NB name.
 */
export function namingLabel(rows: ReadonlyArray<Row>, fallback: string): string {
  return linksOnRows(rows)[0]?.label ?? fallback;
}

/** Does `row` already hold any SportLots id a move off `sourceRows` would carry? By id. */
export function holdsAnyLink(row: Row, sourceRows: ReadonlyArray<Row>): boolean {
  const moving = new Set(linksOnRows(sourceRows).map((l) => l.id));
  return slotIds(row, "sportlots").some((id) => moving.has(id));
}

/**
 * The cards a promote carries: exactly those whose SportLots ref is
 * attributed to `slot` on the parallel. A card also carrying a BSC ref
 * attributed to a slot that STAYS on the row is paired across the split and
 * is counted, never moved — the caller refuses on any.
 */
export function splitCardsForSlot(
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

// ───────────────────────────────────────────────────────────────────────────
// Operator-typed data on the rows a move deletes (security audit, NEO-305)
// ───────────────────────────────────────────────────────────────────────────

/**
 * Feature keys a variant type derives for ITSELF (`deriveOwnLevelFeatures`
 * at variantType: "cardType", "parallelName"). On a Base they say "Base" —
 * a fact about the Base, never about a parallel — so they are never carried.
 */
const BASE_OWN_FEATURE_KEYS = ["cardType", "parallelName"];

/**
 * What the operator may have typed onto the set or its Base, which the
 * delete at the end of a convert would otherwise throw away. The Base's own
 * value wins over the set's (it is the row the checklist hangs off).
 */
export type SourceData = {
  cardNumberPrefix?: string;
  features: Record<string, string>;
  teamIds?: Array<Id<"teams">>;
  /** A "no" to an upstream rename suggestion is on one of the rows. */
  declined: boolean;
};

export function sourceDataOf(set: Row, base: Row): SourceData {
  const features: Record<string, string> = {
    ...(set.features ?? {}),
    ...(base.features ?? {}),
  };
  for (const key of BASE_OWN_FEATURE_KEYS) delete features[key];
  const cardNumberPrefix =
    base.metadata?.cardNumberPrefix ?? set.metadata?.cardNumberPrefix;
  const teamIds =
    base.teamIds && base.teamIds.length > 0
      ? base.teamIds
      : set.teamIds && set.teamIds.length > 0
        ? set.teamIds
        : undefined;
  const declined = [set, base].some(
    (r) =>
      r.declinedUpstreamLabels?.bsc !== undefined ||
      r.declinedUpstreamLabels?.sportlots !== undefined,
  );
  return {
    ...(cardNumberPrefix !== undefined ? { cardNumberPrefix } : {}),
    features,
    ...(teamIds ? { teamIds } : {}),
    declined,
  };
}

/** What a move would leave behind, per field. */
export type ConversionLoss = {
  cardPrefix: boolean;
  /** Feature keys whose value the destination would not keep. */
  featureKeys: string[];
  team: boolean;
  /** Turned-down rename suggestions — never carried: they were about THOSE rows' names. */
  dismissedNames: boolean;
};

export const lossValidator = v.object({
  cardPrefix: v.boolean(),
  featureKeys: v.array(v.string()),
  team: v.boolean(),
  dismissedNames: v.boolean(),
});

/**
 * Onto a NEW row everything but the turned-down names is carried (`dest`
 * null). Onto an EXISTING row nothing is written over the operator's own
 * data there, so whatever differs stays behind.
 */
export function lossOnto(data: SourceData, dest: Row | null): ConversionLoss {
  if (dest === null) {
    return { cardPrefix: false, featureKeys: [], team: false, dismissedNames: data.declined };
  }
  const destTeams = new Set<string>(dest.teamIds ?? []);
  return {
    cardPrefix:
      data.cardNumberPrefix !== undefined &&
      data.cardNumberPrefix !== dest.metadata?.cardNumberPrefix,
    featureKeys: Object.keys(data.features)
      .filter((k) => dest.features?.[k] !== data.features[k])
      .sort(),
    team:
      data.teamIds !== undefined &&
      (data.teamIds.length !== destTeams.size ||
        data.teamIds.some((id) => !destTeams.has(id))),
    dismissedNames: data.declined,
  };
}

/** The dropped fields, by schema name, for the audit log line. */
export function lossFieldNames(loss: ConversionLoss): string[] {
  return [
    ...(loss.cardPrefix ? ["metadata.cardNumberPrefix"] : []),
    ...loss.featureKeys.map((k) => `features.${k}`),
    ...(loss.team ? ["teamIds"] : []),
    ...(loss.dismissedNames ? ["declinedUpstreamLabels"] : []),
  ];
}

// ───────────────────────────────────────────────────────────────────────────
// Shared reads
// ───────────────────────────────────────────────────────────────────────────

export async function childrenOf(
  ctx: { db: QueryCtx["db"] },
  parentId: RowId,
  limit: number,
): Promise<Row[]> {
  return ctx.db
    .query("selectorOptions")
    .withIndex("by_parent", (q) => q.eq("parentId", parentId))
    .take(limit);
}

export async function cardsOn(
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
export async function hasOpenReview(
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

/** The Base of a set: its variant type carrying the NB base role. */
export async function baseOf(
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

/** The brand's sets folded by name, bounded like the sync's year index. */
export async function brandSetsByKey(
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
 * The operator sentences `readConversionSource` refuses with. Each door
 * passes its own, so the copy names that door's destination ("Only a set can
 * become a parallel.") while the guards stay one implementation.
 */
export type ConversionSourceRefusals = {
  setGone: () => string;
  notASet: () => string;
  onBsc: (set: string) => string;
  noBase: (set: string) => string;
  moreThanBase: (set: string) => string;
  baseHasRows: (set: string) => string;
};

export type ConversionSource =
  | { ok: false; reason: string }
  | {
      ok: true;
      set: Row;
      base: Row;
      brand: Row;
    };

/**
 * Source shape S1: a set that is nothing but a Base carrying no BSC link (the
 * shape `insertSetWithBaseFromSl` mints). Every guard that depends on the
 * SOURCE set alone — the ones a row action is shown or hidden by. Reads a
 * handful of rows: the set, at most two of its children, at most one of the
 * Base's, the brand. The review and card checks are the mutation's; an
 * eligibility query does not need them to decide whether to offer the door.
 */
export async function readConversionSource(
  ctx: { db: QueryCtx["db"] },
  setId: RowId,
  refusals: ConversionSourceRefusals,
): Promise<ConversionSource> {
  const set = await ctx.db.get(setId);
  if (!set) return { ok: false, reason: refusals.setGone() };
  if (set.level !== "setName") {
    return { ok: false, reason: refusals.notASet() };
  }
  if (slotIds(set, "bsc").length > 0) {
    return { ok: false, reason: refusals.onBsc(set.value) };
  }
  const children = await childrenOf(ctx, set._id, 2);
  if (children.length === 0) {
    return { ok: false, reason: refusals.noBase(set.value) };
  }
  const base = children[0];
  if (
    children.length > 1 ||
    base.level !== "variantType" ||
    base.metadata?.isBase !== true
  ) {
    return { ok: false, reason: refusals.moreThanBase(set.value) };
  }
  if (slotIds(base, "bsc").length > 0) {
    return { ok: false, reason: refusals.onBsc(set.value) };
  }
  if ((await childrenOf(ctx, base._id, 1)).length > 0) {
    return { ok: false, reason: refusals.baseHasRows(set.value) };
  }
  const brand = set.parentId ? await ctx.db.get(set.parentId) : null;
  if (!brand || brand.level !== "manufacturer") {
    return { ok: false, reason: refusals.setGone() };
  }
  return { ok: true, set, base, brand };
}

// ───────────────────────────────────────────────────────────────────────────
// Writes
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
export async function moveCards(
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
export async function moveGuestCrossListings(
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
