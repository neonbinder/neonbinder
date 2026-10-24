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
import { internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";
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
import { variantTypeKind } from "./variantRole";
import { compareCardNumbers } from "../lib/cards/card-number";
// NEO-358 — a moved card's counts move with it, and so do its collectors'
// copies (their denormalised `variantId` / `setId`).
import { createCardCountLedger } from "./cardCounts";
import { findSetForSelectorOption } from "./lib/selectorAncestry";

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

/**
 * NEO-358 — collectors' copies one move re-points IN its own transaction. Each
 * is one `patch` on top of the card's own, so the move stops re-pointing
 * inline here rather than straining the budget `MAX_CARDS_PER_MOVE` is sized
 * to. It never refuses: what is left over is re-pointed by the scheduled
 * `repointMovedCardCopies` chain, a page at a time. A collector's pile can
 * never block an operator's move.
 */
export const MAX_COPIES_PER_MOVE = 500;

/** Copies one `repointMovedCardCopies` page reads (and at most patches). */
export const COPY_REPOINT_PAGE = 500;

/**
 * NEO-358 — "Sets I'm building" entries one conversion re-points from the set
 * it ends onto its target. Two operations each (the owner's target lookup,
 * then a patch or a delete).
 */
export const MAX_BUILDING_SETS_PER_MOVE = 500;

/** Sets a door's target picker lists for one brand. */
export const MAX_TARGET_SETS = 500;

/**
 * Variant types read under one set when looking for its Insert or Parallel
 * type. A real set has a handful (Base, Insert, Parallel, Promo…); this
 * bounds the read because a door's targets list asks it for up to
 * `MAX_TARGET_SETS` sets.
 */
export const MAX_VARIANT_TYPES_PER_SET = 50;

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
 * Feature keys a row derives for ITSELF from its level (`deriveOwnLevelFeatures`:
 * "cardType" and "parallelName" at variantType, "cardType" at insert and
 * parallel). On a Base they say "Base"; on an insert-level row they say what
 * its OLD place made it ("Parallel" under a Parallel type). Facts about the
 * source's position, never about the destination — which re-derives its own —
 * so they are never carried.
 */
const OWN_LEVEL_FEATURE_KEYS = ["cardType", "parallelName"];

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
  for (const key of OWN_LEVEL_FEATURE_KEYS) delete features[key];
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

/**
 * The same, for a source that is ONE row (NEO-306's S2: an insert-level row
 * with nothing under it). Its own level-derived keys are stripped exactly as
 * a Base's are.
 */
export function sourceDataOfRow(row: Row): SourceData {
  const features: Record<string, string> = { ...(row.features ?? {}) };
  for (const key of OWN_LEVEL_FEATURE_KEYS) delete features[key];
  const cardNumberPrefix = row.metadata?.cardNumberPrefix;
  const teamIds = row.teamIds && row.teamIds.length > 0 ? row.teamIds : undefined;
  const declined =
    row.declinedUpstreamLabels?.bsc !== undefined ||
    row.declinedUpstreamLabels?.sportlots !== undefined;
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

/**
 * The ONE variant type under `setId` of kind `kind`: titled "Insert" /
 * "Inserts" or "Parallel" / "Parallels" (`variantTypeKind`, NEO-334: a
 * variant type's title is its kind). Exactly one or nothing: no match, or
 * more than one (two siblings may not share a word, so two would be a set
 * NB cannot read), is null, which the doors show as "no Insert / Parallel
 * type yet" and refuse on.
 *
 * Bounded (NEO-306 security audit). Past `MAX_VARIANT_TYPES_PER_SET` the
 * answer is FAIL CLOSED: null plus a warning. Nothing is written under a
 * type NB could not read.
 */
export async function variantTypeOfKind(
  ctx: { db: QueryCtx["db"] },
  setId: RowId,
  kind: "insert" | "parallel",
): Promise<Row | null> {
  const types = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "variantType").eq("parentId", setId),
    )
    .take(MAX_VARIANT_TYPES_PER_SET + 1);
  if (types.length > MAX_VARIANT_TYPES_PER_SET) {
    console.warn(
      `[setShapeMove] set=${setId} has more than ${MAX_VARIANT_TYPES_PER_SET} ` +
        `variant types; its ${kind} type was not looked for`,
    );
    return null;
  }
  const found = types.filter((t) => variantTypeKind(t) === kind);
  if (found.length > 1) {
    console.warn(
      `[setShapeMove] set=${setId} has ${found.length} ${kind} variant types; ` +
        `refusing to pick one`,
    );
    return null;
  }
  return found[0] ?? null;
}

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

/**
 * Every `insert`-level row directly under a variant type — its inserts, or
 * its parallels of the base when the type is a Parallel type. Unbounded: a
 * caller that must bound it reads with its own `.take()`.
 */
export async function insertRowsUnder(
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
 * The Base of a set: its ONE variant type titled "Base" (`variantTypeKind`).
 * None, or more than one, is null.
 */
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
  const bases = types.filter((t) => variantTypeKind(t) === "base");
  return bases.length === 1 ? bases[0] : null;
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
    variantTypeKind(base) !== "base"
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
 *
 * NEO-358 — the only re-pointer of cards, so it is also the only re-pointer
 * of what is denormalised from a card's row:
 *  - the counts: each card leaves its old row and lands on `destId`
 *    (`CardCountLedger`, flushed here, once);
 *  - collectors' copies: every copy of a moved card (`collectionCopies.by_card`)
 *    gets `variantId = destId` and `setId` = the destination's set. The first
 *    `MAX_COPIES_PER_MOVE` are re-pointed here, in the move's transaction; a
 *    card whose copies run past that budget is handed to the scheduled
 *    `repointMovedCardCopies` chain, which pages through them. The move never
 *    refuses for copies. Until the chain lands, a left-over copy still names
 *    the card's OLD variant and set; `collection.variantCompletion` only
 *    counts a copy whose card is still on the variant, so no count over-reads
 *    in that window. The chain reads the card's CURRENT row for its target, so
 *    it is safe to retry and safe against a second move in between.
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
  const countLedger = createCardCountLedger();
  // Walked lazily: only a move that carries a collector's copy needs it.
  let destSet: { id: RowId | undefined } | undefined;
  // Copies re-pointed inline so far; past the budget, cards go to `later`.
  let copiesRepointed = 0;
  const later: Array<Id<"cardChecklist">> = [];
  for (let i = 0; i < ordered.length; i++) {
    const { card, slotMap } = ordered[i];
    await ctx.db.patch(card._id, {
      selectorOptionId: destId,
      platformData: remapCardPlatformData(card.platformData, slotMap),
      sortOrder: base + i,
      lastUpdated: now,
    });
    if (card.selectorOptionId !== destId) {
      countLedger.removeCard(card);
      countLedger.addCard({
        selectorOptionId: destId,
        variationOfCardId: card.variationOfCardId,
      });
    }
    const budget = MAX_COPIES_PER_MOVE - copiesRepointed;
    // One read past the budget tells "all of them" from "more than fit".
    const copies =
      budget > 0
        ? await ctx.db
            .query("collectionCopies")
            .withIndex("by_card", (q) => q.eq("cardId", card._id))
            .take(budget + 1)
        : await ctx.db
            .query("collectionCopies")
            .withIndex("by_card", (q) => q.eq("cardId", card._id))
            .take(1);
    if (copies.length === 0) continue;
    destSet ??= { id: await findSetForSelectorOption(ctx, destId) };
    const setId = destSet.id;
    if (!setId) {
      // A destination with no set above it cannot hold a collector's copy.
      // Every door moves cards to a row under a set, so this is a broken
      // chain (a structural refusal, not a collector-driven one); refuse
      // rather than strand the copy.
      throw new ConvexError(
        "That destination isn't under a set, so collectors' copies can't follow the cards there. Nothing was moved.",
      );
    }
    if (copies.length > budget) {
      // Re-point what fits now; the chain finishes this card from the start
      // (it skips a copy already pointing at the card's row).
      later.push(card._id);
    }
    for (const copy of copies.slice(0, budget)) {
      copiesRepointed += 1;
      if (copy.variantId === destId && copy.setId === setId) continue;
      await ctx.db.patch(copy._id, {
        variantId: destId,
        setId,
        lastUpdated: now,
      });
    }
  }
  await countLedger.flush(ctx);
  if (later.length > 0) {
    console.log(
      JSON.stringify({
        msg: "move_cards_copies_deferred",
        cards: later.length,
        repointedInline: copiesRepointed,
      }),
    );
    await ctx.scheduler.runAfter(0, internal.setShapeMove.repointMovedCardCopies, {
      cardIds: later,
      index: 0,
      cursor: null,
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
 * NEO-358 — the tail of `moveCards`: re-point the copies of `cardIds` that the
 * move's own transaction had no budget for, one page of one card per run,
 * scheduling itself until the list is done.
 *
 * The target is read from the card's CURRENT row (its `selectorOptionId`, and
 * that row's set), never carried in the args, so the chain is idempotent and
 * correct after a second move in between: a re-run, or a copy already
 * pointing at the card's row, writes nothing. A card that is gone, or whose
 * row reaches no set, is skipped with a log line; the delete guard
 * (`removeCardRow`) never lets a card with copies go, so the first is a
 * stale list, and the second a broken chain no copy can follow.
 *
 * One `paginate` per run (Convex allows one per function); a card with fewer
 * copies than a page costs one run, which only happens to the cards the move
 * could not finish inline.
 */
export const repointMovedCardCopies = internalMutation({
  args: {
    cardIds: v.array(v.id("cardChecklist")),
    index: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ repointed: v.number(), done: v.boolean() }),
  handler: async (ctx, args) => {
    const index = Number.isInteger(args.index) && args.index >= 0 ? args.index : 0;
    if (index >= args.cardIds.length) return { repointed: 0, done: true };
    const cardId = args.cardIds[index];
    const card = await ctx.db.get(cardId);
    let repointed = 0;
    let next: { index: number; cursor: string | null } = { index: index + 1, cursor: null };
    const setId = card ? await findSetForSelectorOption(ctx, card.selectorOptionId) : undefined;
    if (!card || !setId) {
      console.log(
        JSON.stringify({
          msg: "repoint_moved_card_copies_skipped",
          reason: card ? "no_set" : "card_gone",
        }),
      );
    } else {
      const page = await ctx.db
        .query("collectionCopies")
        .withIndex("by_card", (q) => q.eq("cardId", cardId))
        .paginate({ cursor: args.cursor, numItems: COPY_REPOINT_PAGE });
      const now = Date.now();
      for (const copy of page.page) {
        if (copy.variantId === card.selectorOptionId && copy.setId === setId) continue;
        await ctx.db.patch(copy._id, {
          variantId: card.selectorOptionId,
          setId,
          lastUpdated: now,
        });
        repointed += 1;
      }
      if (!page.isDone) next = { index, cursor: page.continueCursor };
    }
    const done = next.index >= args.cardIds.length;
    if (!done) {
      await ctx.scheduler.runAfter(0, internal.setShapeMove.repointMovedCardCopies, {
        cardIds: args.cardIds,
        ...next,
      });
    }
    return { repointed, done };
  },
});

/**
 * NEO-358 — before a conversion ends a SET row, its collectors' "Sets I'm
 * building" entries move to the set its cards went to: a collector building
 * the source set is now building the target. One entry per (owner, set), so
 * an owner who already has the target keeps that entry and loses the source's.
 * More than `MAX_BUILDING_SETS_PER_MOVE` refuses the whole conversion.
 */
export async function moveBuildingSets(
  ctx: MutationCtx,
  fromSetId: RowId,
  toSetId: RowId,
  now: number,
): Promise<void> {
  if (fromSetId === toSetId) return;
  const entries = await ctx.db
    .query("collectionBuildingSets")
    .withIndex("by_set", (q) => q.eq("setId", fromSetId))
    .take(MAX_BUILDING_SETS_PER_MOVE + 1);
  if (entries.length > MAX_BUILDING_SETS_PER_MOVE) {
    throw new ConvexError(
      `Whoa, more than ${MAX_BUILDING_SETS_PER_MOVE} collectors are building ` +
        `this set, which is more than one move can carry. Nothing was moved.`,
    );
  }
  for (const entry of entries) {
    const already = await ctx.db
      .query("collectionBuildingSets")
      .withIndex("by_owner_and_set", (q) =>
        q.eq("ownerId", entry.ownerId).eq("setId", toSetId),
      )
      .first();
    if (already) {
      await ctx.db.delete(entry._id);
    } else {
      await ctx.db.patch(entry._id, { setId: toSetId, lastUpdated: now });
    }
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
