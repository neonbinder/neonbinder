/**
 * NEO-306 — the SportLots-only review: where the SportLots-only names a Sync
 * Sets finds under a brand wait for the operator to say what each one is.
 *
 * ## Why a review, and not a rule
 *
 * SportLots files many things as "sets" that NB calls something else: 2026
 * Bowman's "Bowman Gold" is a parallel of Bowman, "Bowman All-America Game
 * Autos" is an insert, "Bowman All-America" is a set. No name rule tells
 * them apart, and a marketplace name must never decide an NB shape (product
 * invariant 4). NEO-237 minted every such name as a set; NEO-305 counted the
 * flagship's colours as its parallels and wrote them nowhere. Both went
 * (Jason, 2026-09-25): every SportLots-only name is one ROW of this review,
 * filed by the operator as
 *
 *   - its own set (the default: a set + Base carrying the SportLots id, the
 *     NEO-237 write, `createSetsFromSlRootsImpl`), or
 *   - a row under one variant type of one of the brand's sets that holds a
 *     BSC id: an `insert`-level row carrying the SportLots link, born with
 *     the flags that type's NB role gives it (`derivedVariantFlags`).
 *
 * NB never creates an Insert or Parallel variant type here: the types come
 * from that set's Sync Variant Types (`ensureSelectorOptions`), which the
 * dialog runs once per picked set. The Base-role type is excluded — Base is
 * terminal in the set builder, so a row under it would be unreachable.
 *
 * ## The doc
 *
 * `slSetReviews`, one per (year, brand): what SportLots lists under the
 * brand minus what NB already covers or already has as a set's variant
 * (`routeSlSets`). Written only by `replaceScope`, from Sync Sets, for a
 * brand whose SportLots list came back ok. The save removes each entry in
 * the SAME transaction that files it, so a save that dies part-way leaves
 * exactly the unsaved entries behind, and "save again" finishes the job with
 * no duplicate: a resumed chunk re-reads the doc and skips every id it no
 * longer holds. The doc goes when it is empty.
 *
 * ## Security
 *
 * The client sends ids only: `{slId, variantTypeId?}`. The LABEL always comes
 * from the doc, and an `slId` the doc does not hold is skipped and counted —
 * never written — so a client cannot attach an arbitrary SportLots id. Every
 * variant type is re-validated by id in the transaction that writes under it.
 */

import { ConvexError, v } from "convex/values";
import { internal } from "./_generated/api";
import {
  action,
  internalMutation,
  internalQuery,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";
import { matchKnownBrand } from "./knownBrands";
import { inheritedTeamIds } from "./lib/selectorTeams";
import { MAX_SLOT_LABEL_LENGTH, initialSlots, slotIds } from "./platformSlots";
import { brandSubtreeSlIds, createSetsFromSlRootsImpl } from "./selectorOptions";
import {
  MAX_SL_ID_LENGTH,
  MAX_SL_SETS_PER_SYNC,
  checkCustomSelectorValue,
  matchesBrandPrefix,
  selectorValueKey,
} from "./selectorSyncMatch";
import { unionChildren } from "./selectorSyncStore";
import {
  MAX_SL_SETS_PER_MUTATION,
  candidateDefaultName,
  chunkSlRoots,
} from "./setFromMarketplace";
import { nameAfterPrefixes, targetNamePrefixes } from "./setShapeMove";
import { derivedVariantFlags, variantTypeRole } from "./variantRole";

type Row = Doc<"selectorOptions">;
type RowId = Id<"selectorOptions">;
type ReviewDoc = Doc<"slSetReviews">;

/** Decisions one save accepts: a full review is `MAX_SL_SETS_PER_SYNC`. */
export const MAX_REVIEW_DECISIONS = 200;
/** Rows one write transaction files, in either phase. */
export const REVIEW_CHUNK_SIZE = MAX_SL_SETS_PER_MUTATION;
/** A SportLots set id is a short slug (defined beside `routeSlSets`). */
export { MAX_SL_ID_LENGTH };
/** The brand's sets read for the "Variant of" picker. */
export const MAX_REVIEW_TARGET_SETS = 500;
/** Variant types read under one set for the "Variant type" picker. */
const MAX_VARIANT_TYPES_PER_SET = 100;
/**
 * Siblings read under one variant type for the same-key check. Past it the
 * chunk is REFUSED (fail closed): with siblings unread, "no row by that name"
 * cannot be answered, and a guess would put a second row under one name.
 */
export const MAX_SIBLINGS_PER_TYPE = 3000;

const entryValidator = v.object({ slId: v.string(), label: v.string() });

// ───────────────────────────────────────────────────────────────────────────
// Shared reads
// ───────────────────────────────────────────────────────────────────────────

async function reviewDocFor(
  ctx: { db: QueryCtx["db"] },
  yearId: RowId,
  manufacturerId: RowId,
): Promise<ReviewDoc | null> {
  return await ctx.db
    .query("slSetReviews")
    .withIndex("by_year_and_manufacturer", (q) =>
      q.eq("yearId", yearId).eq("manufacturerId", manufacturerId),
    )
    .unique();
}

/** The brand row and its year, or null when the id is not a brand. */
async function brandOf(
  ctx: { db: QueryCtx["db"] },
  manufacturerId: RowId,
): Promise<(Row & { parentId: RowId }) | null> {
  const brand = await ctx.db.get(manufacturerId);
  if (!brand || brand.level !== "manufacturer" || !brand.parentId) return null;
  return brand as Row & { parentId: RowId };
}

/**
 * The brand's `setName` rows that hold a BSC id — the only sets a review
 * entry may be filed under (their variant types come from a BSC sync; an
 * SportLots-only set has none to offer). Sorted by name.
 */
async function bscHoldingSetsOf(
  ctx: { db: QueryCtx["db"] },
  brandId: RowId,
): Promise<{ sets: Row[]; truncated: boolean }> {
  const rows = await ctx.db
    .query("selectorOptions")
    .withIndex("by_level_and_parent", (q) =>
      q.eq("level", "setName").eq("parentId", brandId),
    )
    .take(MAX_REVIEW_TARGET_SETS + 1);
  const truncated = rows.length > MAX_REVIEW_TARGET_SETS;
  const sets = rows
    .slice(0, MAX_REVIEW_TARGET_SETS)
    .filter((row) => slotIds(row, "bsc").length > 0)
    .sort((a, b) => a.value.localeCompare(b.value));
  return { sets, truncated };
}

/** The NB name a SportLots entry reads as under its brand ("Bowman Gold"). */
function fullNameOf(label: string, brandPrefix: string | undefined): string {
  return candidateDefaultName(label, brandPrefix).defaultName;
}

/**
 * The name an entry gets as a row under `targetSet`'s variant type: its full
 * name with the target set's name taken off the front ("Bowman Gold" under
 * Bowman → "Gold"), the rule the set-shape doors use (`nameAfterPrefixes`).
 * When nothing is left, or the name does not start with the set's, the
 * label stands as SportLots gave it.
 */
export function rowNameUnderSet(
  label: string,
  brandPrefix: string | undefined,
  targetSetValue: string,
): string {
  const full = fullNameOf(label, brandPrefix);
  const stripped = nameAfterPrefixes(
    full,
    targetNamePrefixes(targetSetValue, brandPrefix),
  );
  if (stripped === null || stripped === full.trim()) return label.trim();
  return stripped;
}

/**
 * Why `typeId` cannot receive a review entry of the brand, or null when it
 * can. Validated BY ID: a variantType row, not the Base, whose parent is a
 * `setName` of this brand holding a BSC id.
 */
async function typeRefusal(
  ctx: { db: QueryCtx["db"] },
  brandId: RowId,
  typeId: RowId,
): Promise<{ reason: string } | { type: Row; set: Row }> {
  const type = await ctx.db.get(typeId);
  if (!type || type.level !== "variantType" || !type.parentId) {
    return { reason: "That isn't a variant type." };
  }
  if (variantTypeRole(type) === "base") {
    return { reason: "Nothing can go under the Base. Pick another variant type." };
  }
  const set = await ctx.db.get(type.parentId);
  if (!set || set.level !== "setName" || set.parentId !== brandId) {
    return { reason: "That variant type isn't under one of this brand's sets." };
  }
  if (slotIds(set, "bsc").length === 0) {
    return {
      reason: `${set.value} isn't linked to BSC, so it can't take variants here.`,
    };
  }
  return { type, set };
}

/**
 * The entries of `doc` whose ids are in `slIds`, in `slIds` order, plus how
 * many requested ids the doc no longer holds (saved already, or re-classified
 * away by a concurrent sync).
 */
function entriesStillInDoc(
  doc: ReviewDoc | null,
  slIds: readonly string[],
): { entries: Array<{ slId: string; label: string }>; notInReview: number } {
  const byId = new Map((doc?.entries ?? []).map((e) => [e.slId, e] as const));
  const entries: Array<{ slId: string; label: string }> = [];
  let notInReview = 0;
  const seen = new Set<string>();
  for (const slId of slIds) {
    if (seen.has(slId)) continue;
    seen.add(slId);
    const entry = byId.get(slId);
    if (entry) entries.push(entry);
    else notInReview++;
  }
  return { entries, notInReview };
}

/**
 * Every SportLots id already linked under `brandIds`, read INSIDE the write
 * transaction that is about to link more (NEO-306 security audit): the
 * action's own read is a moment earlier, and a door attaching the same id in
 * between would otherwise put one id on two rows. Each walk is bounded at
 * `MAX_SYNC_ITEMS` rows; a brand too big to walk refuses the chunk, because
 * "not linked" cannot be answered for it.
 */
async function linkedUnderBrands(
  ctx: { db: QueryCtx["db"] },
  brandIds: readonly RowId[],
): Promise<Set<string>> {
  const linked = new Set<string>();
  for (const brandId of new Set(brandIds)) {
    const walked = await brandSubtreeSlIds(ctx, brandId);
    if (walked.truncated) {
      throw new ConvexError(
        "This brand has too many rows to check its SportLots links. Nothing more was saved.",
      );
    }
    for (const id of walked.ids) linked.add(id);
  }
  return linked;
}

/** Drop `slIds` from the doc; delete it when nothing is left. */
async function removeFromDoc(
  ctx: MutationCtx,
  doc: ReviewDoc | null,
  slIds: ReadonlySet<string>,
): Promise<number> {
  if (!doc || slIds.size === 0) return doc?.entries.length ?? 0;
  const next = doc.entries.filter((e) => !slIds.has(e.slId));
  if (next.length === doc.entries.length) return next.length;
  if (next.length === 0) {
    await ctx.db.delete(doc._id);
    return 0;
  }
  await ctx.db.patch(doc._id, { entries: next });
  return next.length;
}

// ───────────────────────────────────────────────────────────────────────────
// Sync Sets writes the doc
// ───────────────────────────────────────────────────────────────────────────

/**
 * Replace one brand's review with what this Sync Sets classified. Called only
 * for a brand whose SportLots list came back ok and whose covered-id read
 * was complete; a failed, paused or unresolvable brand keeps its old doc.
 *
 * Empty → the doc goes. Unchanged → nothing is written (NEO-85: an open
 * dialog is not refreshed for nothing). Entries changed → `saveStartedAt`
 * clears, because the "N left" of a half-finished save no longer describes
 * this list.
 */
export const replaceScope = internalMutation({
  args: {
    yearId: v.id("selectorOptions"),
    manufacturerId: v.id("selectorOptions"),
    entries: v.array(entryValidator),
    rootsTruncated: v.number(),
  },
  returns: v.object({ written: v.boolean(), entries: v.number() }),
  handler: async (ctx, args) => {
    if (args.entries.length > MAX_SL_SETS_PER_SYNC) {
      throw new Error(
        `replaceScope: ${args.entries.length} entries exceeds ${MAX_SL_SETS_PER_SYNC}`,
      );
    }
    for (const entry of args.entries) {
      if (!entry.slId || entry.slId.length > MAX_SL_ID_LENGTH) {
        throw new Error("replaceScope: an entry's SportLots id is not an id");
      }
      if (!entry.label.trim() || entry.label.length > MAX_SLOT_LABEL_LENGTH) {
        throw new Error("replaceScope: an entry's label is not a name");
      }
    }
    const brand = await brandOf(ctx, args.manufacturerId);
    if (!brand || brand.parentId !== args.yearId) {
      throw new Error("replaceScope: not a brand of this year");
    }

    const existing = await reviewDocFor(ctx, args.yearId, args.manufacturerId);
    if (args.entries.length === 0) {
      if (existing) await ctx.db.delete(existing._id);
      return { written: existing !== null, entries: 0 };
    }
    const truncated = args.rootsTruncated > 0 ? args.rootsTruncated : undefined;
    if (existing) {
      const sameEntries =
        existing.entries.length === args.entries.length &&
        existing.entries.every(
          (e, i) =>
            e.slId === args.entries[i].slId && e.label === args.entries[i].label,
        );
      if (sameEntries && existing.rootsTruncated === truncated) {
        return { written: false, entries: existing.entries.length };
      }
      await ctx.db.replace(existing._id, {
        yearId: args.yearId,
        manufacturerId: args.manufacturerId,
        entries: args.entries,
        ...(truncated !== undefined ? { rootsTruncated: truncated } : {}),
        classifiedAt: Date.now(),
        // A half-finished save only survives a re-classification that left
        // the list exactly as it was.
        ...(sameEntries && existing.saveStartedAt !== undefined
          ? { saveStartedAt: existing.saveStartedAt }
          : {}),
      });
      return { written: true, entries: args.entries.length };
    }
    await ctx.db.insert("slSetReviews", {
      yearId: args.yearId,
      manufacturerId: args.manufacturerId,
      entries: args.entries,
      ...(truncated !== undefined ? { rootsTruncated: truncated } : {}),
      classifiedAt: Date.now(),
    });
    return { written: true, entries: args.entries.length };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// What the dialog reads
// ───────────────────────────────────────────────────────────────────────────

/**
 * The Sets column's pill: how many SportLots names wait for this brand, and
 * whether a save stopped part-way ("N left — save again"). `null` when
 * nothing waits. One indexed point read.
 */
export const getSlSetReviewSummary = query({
  args: { manufacturerId: v.id("selectorOptions") },
  returns: v.union(
    v.null(),
    v.object({
      pending: v.number(),
      partial: v.boolean(),
      moreNextSync: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const brand = await brandOf(ctx, args.manufacturerId);
    if (!brand) return null;
    const doc = await reviewDocFor(ctx, brand.parentId, brand._id);
    if (!doc || doc.entries.length === 0) return null;
    return {
      pending: doc.entries.length,
      partial: doc.saveStartedAt !== undefined,
      moreNextSync: doc.rootsTruncated ?? 0,
    };
  },
});

/**
 * The review for one brand: its entries, and the sets an entry may be filed
 * under (the brand's sets holding a BSC id — the "Belongs to" picker).
 *
 * `suggestedOfSetId` is computed HERE, at read time, and is display only: the
 * picker's first option with a `suggested` tag, never preselected, never
 * sent back. It is the longest of those sets whose name is a whole-word
 * prefix of the entry's NB name ("Bowman Gold" → Bowman). Stored, it would
 * dangle when a set is deleted and persist a name-derived value.
 */
export const getSlSetReview = query({
  args: { manufacturerId: v.id("selectorOptions") },
  returns: v.union(
    v.null(),
    v.object({
      yearId: v.id("selectorOptions"),
      manufacturerId: v.id("selectorOptions"),
      brandValue: v.string(),
      entries: v.array(
        v.object({
          slId: v.string(),
          label: v.string(),
          suggestedOfSetId: v.optional(v.id("selectorOptions")),
        }),
      ),
      ofSets: v.array(v.object({ _id: v.id("selectorOptions"), value: v.string() })),
      ofSetsTruncated: v.boolean(),
      moreNextSync: v.number(),
      partial: v.boolean(),
      classifiedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const brand = await brandOf(ctx, args.manufacturerId);
    if (!brand) return null;
    const doc = await reviewDocFor(ctx, brand.parentId, brand._id);
    if (!doc || doc.entries.length === 0) return null;
    const { sets, truncated } = await bscHoldingSetsOf(ctx, brand._id);
    const prefix = brand.metadata?.setNamePrefix;
    const entries = doc.entries.map((entry) => {
      const full = fullNameOf(entry.label, prefix);
      let suggested: Row | undefined;
      for (const set of sets) {
        if (!matchesBrandPrefix(full, set.value)) continue;
        if (selectorValueKey(full) === selectorValueKey(set.value)) continue;
        if (!suggested || set.value.length > suggested.value.length) suggested = set;
      }
      return {
        slId: entry.slId,
        label: entry.label,
        ...(suggested ? { suggestedOfSetId: suggested._id } : {}),
      };
    });
    return {
      yearId: brand.parentId,
      manufacturerId: brand._id,
      brandValue: brand.value,
      entries,
      ofSets: sets.map((s) => ({ _id: s._id, value: s.value })),
      ofSetsTruncated: truncated,
      moreNextSync: doc.rootsTruncated ?? 0,
      partial: doc.saveStartedAt !== undefined,
      classifiedAt: doc.classifiedAt,
    };
  },
});

/**
 * The "Variant type" picker for one set: its variant types with their NB
 * role, the Base excluded (terminal in the set builder). Empty until the
 * set's Sync Variant Types has run — the dialog runs it through
 * `api.selectorOptions.ensureSelectorOptions({level: "variantType",
 * parentId: setId})` and watches `api.selectorOptions.getSelectorSyncStatus`
 * with the same arguments for progress and failure.
 */
export const getVariantTypesOfSet = query({
  args: { setId: v.id("selectorOptions") },
  returns: v.array(
    v.object({
      _id: v.id("selectorOptions"),
      value: v.string(),
      role: v.optional(v.union(v.literal("insert"), v.literal("parallel"))),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const set = await ctx.db.get(args.setId);
    if (!set || set.level !== "setName") return [];
    const types = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "variantType").eq("parentId", set._id),
      )
      .take(MAX_VARIANT_TYPES_PER_SET);
    const out: Array<{ _id: RowId; value: string; role?: "insert" | "parallel" }> = [];
    for (const type of types) {
      const role = variantTypeRole(type);
      if (role === "base") continue;
      out.push({ _id: type._id, value: type.value, ...(role ? { role } : {}) });
    }
    return out.sort((a, b) => a.value.localeCompare(b.value));
  },
});

// ───────────────────────────────────────────────────────────────────────────
// The save: internal pieces
// ───────────────────────────────────────────────────────────────────────────

/** What the save reads once at the start. */
export const readReviewForSave = internalQuery({
  args: { manufacturerId: v.id("selectorOptions") },
  returns: v.union(
    v.null(),
    v.object({
      yearId: v.id("selectorOptions"),
      isBrandUnknown: v.boolean(),
      entries: v.array(entryValidator),
    }),
  ),
  handler: async (ctx, args) => {
    const brand = await brandOf(ctx, args.manufacturerId);
    if (!brand) return null;
    const doc = await reviewDocFor(ctx, brand.parentId, brand._id);
    return {
      yearId: brand.parentId,
      isBrandUnknown: brand.metadata?.isBrandUnknown === true,
      entries: doc?.entries ?? [],
    };
  },
});

/** Every variant type the decisions name, validated by id, before any write. */
export const validateReviewTypes = internalQuery({
  args: {
    manufacturerId: v.id("selectorOptions"),
    typeIds: v.array(v.id("selectorOptions")),
  },
  returns: v.union(v.null(), v.string()),
  handler: async (ctx, args) => {
    for (const typeId of args.typeIds) {
      const checked = await typeRefusal(ctx, args.manufacturerId, typeId);
      if ("reason" in checked) return checked.reason;
    }
    return null;
  },
});

/** Marks a save as started (the pill's "N left — save again" state). */
export const markSaveStarted = internalMutation({
  args: {
    yearId: v.id("selectorOptions"),
    manufacturerId: v.id("selectorOptions"),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const doc = await reviewDocFor(ctx, args.yearId, args.manufacturerId);
    if (doc) await ctx.db.patch(doc._id, { saveStartedAt: Date.now() });
    return null;
  },
});

/** Drops entries the save decided without writing (already covered). */
export const removeReviewEntries = internalMutation({
  args: {
    yearId: v.id("selectorOptions"),
    manufacturerId: v.id("selectorOptions"),
    slIds: v.array(v.string()),
  },
  returns: v.object({ remaining: v.number() }),
  handler: async (ctx, args) => {
    const doc = await reviewDocFor(ctx, args.yearId, args.manufacturerId);
    const remaining = await removeFromDoc(ctx, doc, new Set(args.slIds));
    return { remaining };
  },
});

/**
 * Phase 1: file ≤ `REVIEW_CHUNK_SIZE` entries as their own sets under
 * `targetManufacturerId` (the review's brand, or — for the Unknown brand — a
 * known brand the name belongs to, NEO-294), and remove them from the review
 * in the same transaction. A clash is decided, not retried: it is counted
 * and the entry leaves the review (the next sync offers it again if it is
 * still SportLots-only). A truncated year index files nothing and removes
 * nothing.
 */
export const saveSetsChunk = internalMutation({
  args: {
    yearId: v.id("selectorOptions"),
    reviewManufacturerId: v.id("selectorOptions"),
    targetManufacturerId: v.id("selectorOptions"),
    slIds: v.array(v.string()),
    createdByUserId: v.string(),
  },
  returns: v.object({
    created: v.number(),
    clashedAtTarget: v.number(),
    existsElsewhere: v.number(),
    invalid: v.number(),
    notInReview: v.number(),
    alreadyLinked: v.number(),
    indexTruncated: v.boolean(),
    remaining: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.slIds.length > REVIEW_CHUNK_SIZE) {
      throw new Error(`saveSetsChunk: more than ${REVIEW_CHUNK_SIZE} entries`);
    }
    const doc = await reviewDocFor(ctx, args.yearId, args.reviewManufacturerId);
    const { entries, notInReview } = entriesStillInDoc(doc, args.slIds);
    const nothing = {
      created: 0,
      clashedAtTarget: 0,
      existsElsewhere: 0,
      invalid: 0,
      notInReview,
      alreadyLinked: 0,
      indexTruncated: false,
      remaining: doc?.entries.length ?? 0,
    };
    if (entries.length === 0) return nothing;
    // Already linked under the review's brand, or under the known brand the
    // Unknown review files it to — decided here, in this transaction.
    const linked = await linkedUnderBrands(ctx, [
      args.reviewManufacturerId,
      args.targetManufacturerId,
    ]);
    const toCreate = entries.filter((e) => !linked.has(e.slId));
    const alreadyLinked = entries.length - toCreate.length;
    const written =
      toCreate.length > 0
        ? await createSetsFromSlRootsImpl(ctx, {
            manufacturerId: args.targetManufacturerId,
            roots: toCreate.map((e) => ({ id: e.slId, label: e.label })),
            createdByUserId: args.createdByUserId,
          })
        : { ...nothing, notInReview: 0 };
    if (written.indexTruncated) {
      return { ...written, notInReview, alreadyLinked: 0, remaining: nothing.remaining };
    }
    const remaining = await removeFromDoc(ctx, doc, new Set(entries.map((e) => e.slId)));
    return {
      created: written.created,
      clashedAtTarget: written.clashedAtTarget,
      existsElsewhere: written.existsElsewhere,
      invalid: written.invalid,
      indexTruncated: false,
      notInReview,
      alreadyLinked,
      remaining,
    };
  },
});

/**
 * Phase 2: file ≤ `REVIEW_CHUNK_SIZE` entries as `insert`-level rows under
 * one variant type, and remove them from the review in the same transaction.
 *
 * Each row: the entry's name with the target set's taken off the front
 * (`rowNameUnderSet`), the SportLots link in its own slot
 * (`initialSlots({sportlots})` — no BSC slot is written or read), the flags
 * the type's NB role gives it (`derivedVariantFlags`), the type's features
 * copied down plus its own level's, the type's teams. A sibling under the
 * type that already folds to the name, or already holds the SportLots id, is
 * SKIPPED and counted — never merged by name. The type is re-validated by id
 * here, inside the write.
 */
export const createSlRowsUnderVariantType = internalMutation({
  args: {
    yearId: v.id("selectorOptions"),
    manufacturerId: v.id("selectorOptions"),
    typeId: v.id("selectorOptions"),
    slIds: v.array(v.string()),
    createdByUserId: v.string(),
  },
  returns: v.object({
    created: v.number(),
    role: v.union(v.literal("insert"), v.literal("parallel"), v.literal("none")),
    nameTaken: v.number(),
    alreadyLinked: v.number(),
    invalid: v.number(),
    notInReview: v.number(),
    remaining: v.number(),
  }),
  handler: async (ctx, args) => {
    if (args.slIds.length > REVIEW_CHUNK_SIZE) {
      throw new Error(
        `createSlRowsUnderVariantType: more than ${REVIEW_CHUNK_SIZE} entries`,
      );
    }
    const brand = await brandOf(ctx, args.manufacturerId);
    if (!brand || brand.parentId !== args.yearId) {
      throw new ConvexError("That brand is gone. Close the dialog and sync again.");
    }
    const checked = await typeRefusal(ctx, brand._id, args.typeId);
    if ("reason" in checked) throw new ConvexError(checked.reason);
    const { type, set } = checked;
    const typeRole = variantTypeRole(type);
    const role: "insert" | "parallel" | "none" =
      typeRole === "insert" || typeRole === "parallel" ? typeRole : "none";

    const doc = await reviewDocFor(ctx, args.yearId, brand._id);
    const { entries, notInReview } = entriesStillInDoc(doc, args.slIds);

    const siblings = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "insert").eq("parentId", type._id),
      )
      .take(MAX_SIBLINGS_PER_TYPE + 1);
    if (siblings.length > MAX_SIBLINGS_PER_TYPE) {
      throw new ConvexError(
        `${type.value} under ${set.value} has more than ${MAX_SIBLINGS_PER_TYPE} rows, ` +
          `so a new one can't be checked against them. Nothing more was saved.`,
      );
    }
    const siblingKeys = new Set(siblings.map((s) => selectorValueKey(s.value)));
    // Every id already linked anywhere under the brand, read in THIS
    // transaction (the type's own siblings are part of that walk).
    const heldIds = await linkedUnderBrands(ctx, [brand._id]);
    for (const id of siblings.flatMap((s) => slotIds(s, "sportlots"))) heldIds.add(id);

    const flags = derivedVariantFlags("insert", type);
    const teamIds = inheritedTeamIds(type);
    const now = Date.now();
    const prefix = brand.metadata?.setNamePrefix;
    const newIds: RowId[] = [];
    let nameTaken = 0;
    let alreadyLinked = 0;
    let invalid = 0;
    for (const entry of entries) {
      if (heldIds.has(entry.slId)) {
        alreadyLinked++;
        continue;
      }
      const named = checkCustomSelectorValue(
        "insert",
        rowNameUnderSet(entry.label, prefix, set.value),
      );
      if (!named.ok) {
        invalid++;
        continue;
      }
      const key = selectorValueKey(named.value);
      if (siblingKeys.has(key)) {
        nameTaken++;
        continue;
      }
      const slots = initialSlots({
        sportlots: [{ id: entry.slId, label: entry.label }],
      });
      const features = {
        ...(type.features ?? {}),
        ...deriveOwnLevelFeatures("insert", named.value, flags),
      };
      const id = await ctx.db.insert("selectorOptions", {
        level: "insert",
        value: named.value,
        platformData: slots.platformData,
        platformLabels: slots.platformLabels,
        platformSlotSeq: slots.platformSlotSeq,
        parentId: type._id,
        children: [],
        createdByUserId: args.createdByUserId,
        ...(flags ? { metadata: { ...flags } } : {}),
        ...(Object.keys(features).length > 0 ? { features } : {}),
        ...(teamIds ? { teamIds } : {}),
        lastUpdated: now,
      });
      siblingKeys.add(key);
      heldIds.add(entry.slId);
      newIds.push(id);
    }
    if (newIds.length > 0) {
      await ctx.db.patch(type._id, { children: unionChildren(type.children, newIds) });
    }
    const remaining = await removeFromDoc(
      ctx,
      doc,
      new Set(entries.map((e) => e.slId)),
    );
    console.log(
      JSON.stringify({
        msg: "sl_review_rows_under_type",
        adminUserId: args.createdByUserId,
        typeId: type._id,
        role,
        created: newIds.length,
        nameTaken,
        alreadyLinked,
        invalid,
        notInReview,
      }),
    );
    return {
      created: newIds.length,
      role,
      nameTaken,
      alreadyLinked,
      invalid,
      notInReview,
      remaining,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// The save: the action
// ───────────────────────────────────────────────────────────────────────────

const decisionValidator = v.object({
  slId: v.string(),
  variantTypeId: v.optional(v.id("selectorOptions")),
});

const applyResultValidator = v.object({
  /** Entries filed as their own set. */
  sets: v.number(),
  /** Entries filed under a variant type, by that type's NB role. */
  underType: v.object({
    insert: v.number(),
    parallel: v.number(),
    none: v.number(),
  }),
  /** Entries decided without a write, total and by reason. */
  skipped: v.number(),
  skippedByReason: v.object({
    /** Not in the review any more (saved already, or re-synced away). */
    notInReview: v.number(),
    /** The SportLots id is already linked under the brand. */
    alreadyLinked: v.number(),
    /** A set, or a row under the type, already has that name. */
    nameTaken: v.number(),
    /** A set by that name exists under another brand of the year. */
    existsElsewhere: v.number(),
    /** No NB name can be made of it. */
    invalid: v.number(),
  }),
  /** Brands minted from the known list for Unknown's sets (NEO-294). */
  knownBrandsAdded: v.number(),
  /** Entries still in the review after this save. */
  remaining: v.number(),
  /**
   * The save stopped before the end (a write failed, or the year has too
   * many sets to check for duplicates). What was saved stays saved; the
   * rest is still in the review — "save again" finishes it.
   */
  incomplete: v.boolean(),
});

export type ApplySlSetReviewResult = {
  sets: number;
  underType: { insert: number; parallel: number; none: number };
  skipped: number;
  skippedByReason: {
    notInReview: number;
    alreadyLinked: number;
    nameTaken: number;
    existsElsewhere: number;
    invalid: number;
  };
  knownBrandsAdded: number;
  remaining: number;
  incomplete: boolean;
};

export type ApplySlSetReviewArgs = {
  manufacturerId: RowId;
  decisions: Array<{ slId: string; variantTypeId?: RowId }>;
};

/**
 * The whole save, as a plain function over the two action capabilities it
 * uses, so a test can hand it a `runMutation` that fails on a chosen call
 * (convex-test cannot make a transaction fail on its own).
 */
export async function applySlSetReviewImpl(
  ctx: Pick<ActionCtx, "runQuery" | "runMutation">,
  adminUserId: string,
  args: ApplySlSetReviewArgs,
): Promise<ApplySlSetReviewResult> {
  if (args.decisions.length > MAX_REVIEW_DECISIONS) {
    throw new ConvexError(
      `Save at most ${MAX_REVIEW_DECISIONS} SportLots sets at a time.`,
    );
  }
  const review = await ctx.runQuery(internal.slSetReview.readReviewForSave, {
    manufacturerId: args.manufacturerId,
  });
  if (!review) {
    throw new ConvexError("That brand is gone. Close the dialog and sync again.");
  }
  const { yearId } = review;

  const result: ApplySlSetReviewResult = {
    sets: 0,
    underType: { insert: 0, parallel: 0, none: 0 },
    skipped: 0,
    skippedByReason: {
      notInReview: 0,
      alreadyLinked: 0,
      nameTaken: 0,
      existsElsewhere: 0,
      invalid: 0,
    },
    knownBrandsAdded: 0,
    remaining: review.entries.length,
    incomplete: false,
  };
  const skip = (reason: keyof ApplySlSetReviewResult["skippedByReason"], n: number) => {
    result.skippedByReason[reason] += n;
    result.skipped += n;
  };

  // Deduplicate by slId (first decision wins); an id the doc does not hold
  // is skipped and counted, never written.
  const inDoc = new Map(review.entries.map((e) => [e.slId, e] as const));
  const seen = new Set<string>();
  const decisions: Array<{ slId: string; label: string; variantTypeId?: RowId }> = [];
  for (const d of args.decisions) {
    if (seen.has(d.slId)) continue;
    seen.add(d.slId);
    const entry = inDoc.get(d.slId);
    if (!entry) {
      skip("notInReview", 1);
      continue;
    }
    decisions.push({ ...entry, ...(d.variantTypeId ? { variantTypeId: d.variantTypeId } : {}) });
  }

  // Every named type validated by id before anything is written.
  const typeIds = [...new Set(decisions.flatMap((d) => (d.variantTypeId ? [d.variantTypeId] : [])))];
  if (typeIds.length > 0) {
    const refusal = await ctx.runQuery(internal.slSetReview.validateReviewTypes, {
      manufacturerId: args.manufacturerId,
      typeIds,
    });
    if (refusal) throw new ConvexError(refusal);
  }
  if (decisions.length === 0) return result;

  // An id already linked under the brand is decided without a write.
  const covered = await ctx.runQuery(internal.selectorOptions.listBrandSubtreeSlIds, {
    manufacturerId: args.manufacturerId,
  });
  if (covered.truncated) {
    throw new ConvexError(
      "This brand has too many rows to check its SportLots links. Nothing was saved.",
    );
  }
  const coveredIds = new Set(covered.ids);
  const coveredNow = decisions.filter((d) => coveredIds.has(d.slId));
  const toFile = decisions.filter((d) => !coveredIds.has(d.slId));

  await ctx.runMutation(internal.slSetReview.markSaveStarted, {
    yearId,
    manufacturerId: args.manufacturerId,
  });
  if (coveredNow.length > 0) {
    const removed = await ctx.runMutation(internal.slSetReview.removeReviewEntries, {
      yearId,
      manufacturerId: args.manufacturerId,
      slIds: coveredNow.map((d) => d.slId),
    });
    skip("alreadyLinked", coveredNow.length);
    result.remaining = removed.remaining;
  }

  try {
    // ── Phase 1: own sets ─────────────────────────────────────────────
    const asSets = toFile.filter((d) => !d.variantTypeId);
    // NEO-294 — under the Unknown brand, a name matching a known brand is
    // filed under THAT brand (minted if needed), exactly as Sync Sets did
    // before the review. A placement, not a role; every other brand files
    // under itself.
    const groups: Array<{ target: RowId; slIds: string[] }> = [];
    const rest: string[] = [];
    if (review.isBrandUnknown) {
      const byBrand = new Map<string, { brand: string; slIds: string[] }>();
      for (const d of asSets) {
        const known = matchKnownBrand(d.label);
        if (known === undefined) {
          rest.push(d.slId);
          continue;
        }
        const key = selectorValueKey(known);
        const group = byBrand.get(key);
        if (group) group.slIds.push(d.slId);
        else byBrand.set(key, { brand: known, slIds: [d.slId] });
      }
      for (const group of byBrand.values()) {
        const ensured = await ctx.runMutation(internal.selectorOptions.ensureBrandRow, {
          yearId,
          name: group.brand,
        });
        if (ensured.id === null) {
          rest.push(...group.slIds);
          continue;
        }
        if (ensured.created) result.knownBrandsAdded++;
        groups.push({ target: ensured.id, slIds: group.slIds });
      }
    } else {
      rest.push(...asSets.map((d) => d.slId));
    }
    if (rest.length > 0) groups.push({ target: args.manufacturerId, slIds: rest });

    phase1: for (const group of groups) {
      for (const chunk of chunkSlRoots(group.slIds, REVIEW_CHUNK_SIZE)) {
        const written = await ctx.runMutation(internal.slSetReview.saveSetsChunk, {
          yearId,
          reviewManufacturerId: args.manufacturerId,
          targetManufacturerId: group.target,
          slIds: chunk,
          createdByUserId: adminUserId,
        });
        result.remaining = written.remaining;
        if (written.indexTruncated) {
          // The year's set index is over its cap: no duplicate check can be
          // answered, so nothing more is filed as a set this save.
          result.incomplete = true;
          break phase1;
        }
        result.sets += written.created;
        skip("alreadyLinked", written.alreadyLinked);
        skip("nameTaken", written.clashedAtTarget);
        skip("existsElsewhere", written.existsElsewhere);
        skip("invalid", written.invalid);
        skip("notInReview", written.notInReview);
      }
    }

    // ── Phase 2: rows under a variant type ────────────────────────────
    const byType = new Map<RowId, string[]>();
    for (const d of toFile) {
      if (!d.variantTypeId) continue;
      const list = byType.get(d.variantTypeId) ?? [];
      list.push(d.slId);
      byType.set(d.variantTypeId, list);
    }
    for (const [typeId, slIds] of byType) {
      for (const chunk of chunkSlRoots(slIds, REVIEW_CHUNK_SIZE)) {
        const written: {
          created: number;
          role: "insert" | "parallel" | "none";
          nameTaken: number;
          alreadyLinked: number;
          invalid: number;
          notInReview: number;
          remaining: number;
        } = await ctx.runMutation(
          internal.slSetReview.createSlRowsUnderVariantType,
          {
            yearId,
            manufacturerId: args.manufacturerId,
            typeId,
            slIds: chunk,
            createdByUserId: adminUserId,
          },
        );
        result.remaining = written.remaining;
        result.underType[written.role] += written.created;
        skip("nameTaken", written.nameTaken);
        skip("alreadyLinked", written.alreadyLinked);
        skip("invalid", written.invalid);
        skip("notInReview", written.notInReview);
      }
    }
  } catch (error) {
    // What committed stays committed and left the review; the rest is still
    // there. The operator's "save again" re-sends the same decisions and a
    // resumed chunk skips every id it no longer holds, so nothing doubles.
    // A refusal sentence (a type that stopped qualifying mid-save) is the
    // operator's to read; anything else is logged and reported as partial.
    if (error instanceof ConvexError) throw error;
    console.error(
      JSON.stringify({
        msg: "sl_review_save_incomplete",
        adminUserId,
        manufacturerId: args.manufacturerId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    result.incomplete = true;
    const after = await ctx.runQuery(internal.slSetReview.readReviewForSave, {
      manufacturerId: args.manufacturerId,
    });
    result.remaining = after?.entries.length ?? result.remaining;
  }

  console.log(
    JSON.stringify({
      msg: "sl_review_saved",
      adminUserId,
      manufacturerId: args.manufacturerId,
      decisions: args.decisions.length,
      sets: result.sets,
      underType: result.underType,
      skipped: result.skipped,
      knownBrandsAdded: result.knownBrandsAdded,
      remaining: result.remaining,
      incomplete: result.incomplete,
    }),
  );
  return result;
}

/**
 * Save the operator's decisions for one brand's review. Each decision is
 * `{slId}` (its own set, the default) or `{slId, variantTypeId}` (a row under
 * that variant type of one of the brand's BSC-linked sets). Admin only; at
 * most `MAX_REVIEW_DECISIONS`. Additive: nothing is renamed or deleted.
 */
export const applySlSetReview = action({
  args: {
    manufacturerId: v.id("selectorOptions"),
    decisions: v.array(decisionValidator),
  },
  returns: applyResultValidator,
  handler: async (ctx, args): Promise<ApplySlSetReviewResult> => {
    const adminUserId = await requireAdmin(ctx);
    return await applySlSetReviewImpl(ctx, adminUserId, args);
  },
});
