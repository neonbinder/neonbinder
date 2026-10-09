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

const entryValidator = v.object({
  slId: v.string(),
  label: v.string(),
  /** NEO-325 — see `slSetReviews.entries` in schema.ts. */
  twin: v.optional(v.boolean()),
});

/** A stored entry, its last name refusal included (NEO-325). */
type ReviewEntry = ReviewDoc["entries"][number];
/** What a line's last refusal stores: a `RefusedLine` without its id and label. */
type LastRefusal = NonNullable<ReviewEntry["lastRefusal"]>;

/**
 * NEO-325 — a review line the save REFUSED for its name. It is NOT removed
 * from the review: the operator renames it (the decision's `name`) and saves
 * again. Before this a refused line left the review, and a SportLots twin of
 * a set the operator had just saved never came back.
 *
 *   reason   — `nameTaken`: a set under the brand (own-set line) or a row
 *              under the variant type (variant line) already folds to
 *              `name`; `existsElsewhere`: a set under ANOTHER brand of the
 *              year folds to it; `invalid`: no NB name can be made of it
 *              (`detail` says why, in our words).
 *   name     — the name the save tried: the operator's, or the default.
 *   target   — `set` (own set) or `variantType` (with `variantTypeId`).
 *   clashWith — the NB row already holding the name, and for
 *              `existsElsewhere` the brand it sits under.
 */
export const refusedLineValidator = v.object({
  slId: v.string(),
  label: v.string(),
  name: v.string(),
  reason: v.union(
    v.literal("nameTaken"),
    v.literal("existsElsewhere"),
    v.literal("invalid"),
  ),
  target: v.union(v.literal("set"), v.literal("variantType")),
  variantTypeId: v.optional(v.id("selectorOptions")),
  clashWith: v.optional(
    v.object({
      _id: v.id("selectorOptions"),
      value: v.string(),
      brand: v.optional(v.string()),
    }),
  ),
  detail: v.optional(v.string()),
});

export type RefusedLine = {
  slId: string;
  label: string;
  name: string;
  reason: "nameTaken" | "existsElsewhere" | "invalid";
  target: "set" | "variantType";
  variantTypeId?: RowId;
  clashWith?: { _id: RowId; value: string; brand?: string };
  detail?: string;
};

/**
 * NEO-325 — `slSetReviews.entries[].lastRefusal` as `getSlSetReview` returns
 * it: the line's last name refusal, stored so a reopened review still says
 * why. Same fields as `refusedLineValidator` without `slId` and `label`.
 */
export const lastRefusalValidator = v.object({
  name: v.string(),
  reason: v.union(
    v.literal("nameTaken"),
    v.literal("existsElsewhere"),
    v.literal("invalid"),
  ),
  target: v.union(v.literal("set"), v.literal("variantType")),
  variantTypeId: v.optional(v.id("selectorOptions")),
  clashWith: v.optional(
    v.object({
      _id: v.id("selectorOptions"),
      value: v.string(),
      brand: v.optional(v.string()),
    }),
  ),
  detail: v.optional(v.string()),
});

/** The stored form of a refusal: no id or label (the entry carries both). */
function lastRefusalOf(r: RefusedLine): LastRefusal {
  return {
    name: r.name,
    reason: r.reason,
    target: r.target,
    ...(r.variantTypeId ? { variantTypeId: r.variantTypeId } : {}),
    ...(r.clashWith ? { clashWith: r.clashWith } : {}),
    ...(r.detail !== undefined ? { detail: r.detail } : {}),
  };
}

/** An entry as the sync and the save's first read see it: no refusal. */
function bareEntry(e: ReviewEntry): { slId: string; label: string; twin?: boolean } {
  return { slId: e.slId, label: e.label, ...(e.twin === true ? { twin: true } : {}) };
}

/** Per-line operator names a save chunk carries (NEO-325). */
const namesValidator = v.optional(
  v.array(v.object({ slId: v.string(), name: v.string() })),
);

/** The operator's name for each id, trimmed; blank names are no name. */
function namesById(
  names: ReadonlyArray<{ slId: string; name: string }> | undefined,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of names ?? []) {
    const name = n.name.trim();
    if (name && !out.has(n.slId)) out.set(n.slId, name);
  }
  return out;
}

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
): { entries: ReviewEntry[]; notInReview: number } {
  const byId = new Map((doc?.entries ?? []).map((e) => [e.slId, e] as const));
  const entries: ReviewEntry[] = [];
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

/**
 * Drop `slIds` from the doc and record each of `refused` on its line
 * (NEO-325: `lastRefusal`, replacing any earlier one); delete the doc when
 * nothing is left. One write, in the transaction that filed the lines. A
 * refused id the doc no longer holds is ignored.
 */
async function settleInDoc(
  ctx: MutationCtx,
  doc: ReviewDoc | null,
  slIds: ReadonlySet<string>,
  refused: readonly RefusedLine[] = [],
): Promise<number> {
  if (!doc || (slIds.size === 0 && refused.length === 0)) {
    return doc?.entries.length ?? 0;
  }
  const refusalOf = new Map(refused.map((r) => [r.slId, lastRefusalOf(r)] as const));
  const next = doc.entries
    .filter((e) => !slIds.has(e.slId))
    .map((e) => {
      const refusal = refusalOf.get(e.slId);
      return refusal ? { ...e, lastRefusal: refusal } : e;
    });
  if (next.length === 0) {
    await ctx.db.delete(doc._id);
    return 0;
  }
  if (next.length === doc.entries.length && refusalOf.size === 0) return next.length;
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
            e.slId === args.entries[i].slId &&
            e.label === args.entries[i].label &&
            (e.twin === true) === (args.entries[i].twin === true),
        );
      if (sameEntries && existing.rootsTruncated === truncated) {
        return { written: false, entries: existing.entries.length };
      }
      // NEO-325 — a line the sync left exactly as it was (same id, same
      // label) keeps its last name refusal; any other line starts clean.
      const refusalOf = new Map(
        existing.entries.flatMap((e) =>
          e.lastRefusal ? [[e.slId, { label: e.label, refusal: e.lastRefusal }] as const] : [],
        ),
      );
      const entries: ReviewEntry[] = args.entries.map((e) => {
        const kept = refusalOf.get(e.slId);
        return kept && kept.label === e.label ? { ...e, lastRefusal: kept.refusal } : e;
      });
      await ctx.db.replace(existing._id, {
        yearId: args.yearId,
        manufacturerId: args.manufacturerId,
        entries,
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
          /**
           * NEO-325 — what an own-set save names this line when the operator
           * gives no name (`candidateDefaultName`): the field's prefill.
           */
          defaultName: v.string(),
          /**
           * NEO-325 — two or more distinct SportLots ids share this label in
           * the brand's list (`routeSlSets`). Show the id (D2); the operator
           * names the line. Absent = not a twin.
           */
          twin: v.optional(v.boolean()),
          /**
           * NEO-325 — why the last save that reached this line refused it
           * for its name (stored on the entry, so a reopened review still
           * says why). Absent = never refused, or filed since.
           */
          lastRefusal: v.optional(lastRefusalValidator),
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
        defaultName: full,
        ...(entry.twin === true ? { twin: true } : {}),
        ...(entry.lastRefusal ? { lastRefusal: entry.lastRefusal } : {}),
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
      entries: (doc?.entries ?? []).map(bareEntry),
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

/**
 * Marks a save as started (the pill's "N left — save again" state) and
 * returns the stamp, which the save hands back to `markSaveFinished`.
 */
export const markSaveStarted = internalMutation({
  args: {
    yearId: v.id("selectorOptions"),
    manufacturerId: v.id("selectorOptions"),
  },
  returns: v.union(v.null(), v.number()),
  handler: async (ctx, args) => {
    const doc = await reviewDocFor(ctx, args.yearId, args.manufacturerId);
    if (!doc) return null;
    const startedAt = Date.now();
    await ctx.db.patch(doc._id, { saveStartedAt: startedAt });
    return startedAt;
  },
});

/**
 * NEO-325 — a save that ran to the end (not `incomplete`) clears its
 * `saveStartedAt`, so "partial" means only a save that stopped part-way, not
 * one that left name-refused or undecided lines. Cleared only when the doc
 * still carries THIS save's stamp: a save started since keeps its own mark.
 */
export const markSaveFinished = internalMutation({
  args: {
    yearId: v.id("selectorOptions"),
    manufacturerId: v.id("selectorOptions"),
    startedAt: v.number(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const doc = await reviewDocFor(ctx, args.yearId, args.manufacturerId);
    if (!doc || doc.saveStartedAt !== args.startedAt) return false;
    await ctx.db.patch(doc._id, { saveStartedAt: undefined });
    return true;
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
    const remaining = await settleInDoc(ctx, doc, new Set(args.slIds));
    return { remaining };
  },
});

/**
 * Phase 1: file ≤ `REVIEW_CHUNK_SIZE` entries as their own sets under
 * `targetManufacturerId` (the review's brand, or — for the Unknown brand — a
 * known brand the name belongs to, NEO-294), and remove them from the review
 * in the same transaction. NEO-325 — a line refused for its NAME (a set by
 * that name under the brand or elsewhere in the year, or no valid name) is
 * counted, reported in `refused` and KEPT in the review for the operator to
 * rename; only filed and already-linked lines leave. A truncated year index
 * files nothing and removes nothing.
 */
export const saveSetsChunk = internalMutation({
  args: {
    yearId: v.id("selectorOptions"),
    reviewManufacturerId: v.id("selectorOptions"),
    targetManufacturerId: v.id("selectorOptions"),
    slIds: v.array(v.string()),
    /** NEO-325 — the operator's name per line; absent = the default name. */
    names: namesValidator,
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
    /** NEO-325 — the lines refused for their name; still in the review. */
    refused: v.array(refusedLineValidator),
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
      refused: [] as RefusedLine[],
    };
    if (entries.length === 0) return nothing;
    const names = namesById(args.names);
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
            roots: toCreate.map((e) => {
              const name = names.get(e.slId);
              return { id: e.slId, label: e.label, ...(name ? { name } : {}) };
            }),
            createdByUserId: args.createdByUserId,
          })
        : {
            created: 0,
            createdIds: [] as string[],
            clashedAtTarget: 0,
            existsElsewhere: 0,
            invalid: 0,
            refused: [],
            indexTruncated: false,
          };
    if (written.indexTruncated) {
      return { ...nothing, notInReview, indexTruncated: true };
    }
    const labelOf = new Map(entries.map((e) => [e.slId, e.label] as const));
    const refused: RefusedLine[] = written.refused.map((r) => ({
      slId: r.id,
      label: labelOf.get(r.id) ?? "",
      name: r.name,
      reason: r.reason,
      target: "set",
      ...(r.clashWith ? { clashWith: r.clashWith } : {}),
      ...(r.detail !== undefined ? { detail: r.detail } : {}),
    }));
    // Only what was filed, or is linked already, leaves the review.
    const refusedIds = new Set(refused.map((r) => r.slId));
    const remaining = await settleInDoc(
      ctx,
      doc,
      new Set(entries.map((e) => e.slId).filter((id) => !refusedIds.has(id))),
      refused,
    );
    return {
      created: written.created,
      clashedAtTarget: written.clashedAtTarget,
      existsElsewhere: written.existsElsewhere,
      invalid: written.invalid,
      indexTruncated: false,
      notInReview,
      alreadyLinked,
      remaining,
      refused,
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
 * type that already holds the SportLots id is SKIPPED and counted (the line
 * leaves the review: it is linked). A sibling that already folds to the name,
 * or a name no row can carry, is never merged by name: NEO-325 — the line is
 * reported in `refused` and KEPT in the review for the operator to rename.
 * The operator's per-line `name` replaces `rowNameUnderSet`. The type is
 * re-validated by id here, inside the write.
 */
export const createSlRowsUnderVariantType = internalMutation({
  args: {
    yearId: v.id("selectorOptions"),
    manufacturerId: v.id("selectorOptions"),
    typeId: v.id("selectorOptions"),
    slIds: v.array(v.string()),
    /** NEO-325 — the operator's name per line; absent = `rowNameUnderSet`. */
    names: namesValidator,
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
    /** NEO-325 — the lines refused for their name; still in the review. */
    refused: v.array(refusedLineValidator),
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
    // Key → the sibling holding it, so a refusal can name the row (NEO-325).
    const siblingKeys = new Map<string, { _id: RowId; value: string }>();
    for (const sib of siblings) {
      const key = selectorValueKey(sib.value);
      if (!siblingKeys.has(key)) siblingKeys.set(key, { _id: sib._id, value: sib.value });
    }
    const names = namesById(args.names);
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
    const refused: RefusedLine[] = [];
    for (const entry of entries) {
      if (heldIds.has(entry.slId)) {
        alreadyLinked++;
        continue;
      }
      const tried =
        names.get(entry.slId) ?? rowNameUnderSet(entry.label, prefix, set.value);
      const named = checkCustomSelectorValue("insert", tried);
      if (!named.ok) {
        invalid++;
        refused.push({
          slId: entry.slId,
          label: entry.label,
          name: tried,
          reason: "invalid",
          target: "variantType",
          variantTypeId: type._id,
          detail: named.reason,
        });
        continue;
      }
      const key = selectorValueKey(named.value);
      const holder = siblingKeys.get(key);
      if (holder) {
        nameTaken++;
        refused.push({
          slId: entry.slId,
          label: entry.label,
          name: named.value,
          reason: "nameTaken",
          target: "variantType",
          variantTypeId: type._id,
          clashWith: holder,
        });
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
      siblingKeys.set(key, { _id: id, value: named.value });
      heldIds.add(entry.slId);
      newIds.push(id);
    }
    if (newIds.length > 0) {
      await ctx.db.patch(type._id, { children: unionChildren(type.children, newIds) });
    }
    // Only what was filed, or is linked already, leaves the review.
    const refusedIds = new Set(refused.map((r) => r.slId));
    const remaining = await settleInDoc(
      ctx,
      doc,
      new Set(entries.map((e) => e.slId).filter((id) => !refusedIds.has(id))),
      refused,
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
      refused,
    };
  },
});

// ───────────────────────────────────────────────────────────────────────────
// The save: the action
// ───────────────────────────────────────────────────────────────────────────

const decisionValidator = v.object({
  slId: v.string(),
  variantTypeId: v.optional(v.id("selectorOptions")),
  /**
   * NEO-325 — the operator's name for this line. Own set: the set's name
   * (replaces `candidateDefaultName`, so no brand prefix is added). Under a
   * variant type: the row's name (replaces `rowNameUnderSet`). Blank or
   * absent = the default. Validated by the per-level rule in the write.
   */
  name: v.optional(v.string()),
});

/** Bound on one operator name sent with a decision (a hard arg guard). */
export const MAX_DECISION_NAME_LENGTH = 500;

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
  /**
   * NEO-325 — every line refused for its NAME, with why. These lines are
   * STILL IN THE REVIEW (counted in `remaining` and, by reason, in
   * `skippedByReason`); the operator gives each a name and saves again.
   * At most `MAX_REVIEW_DECISIONS` (one per decision).
   */
  refused: v.array(refusedLineValidator),
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
  refused: RefusedLine[];
  remaining: number;
  incomplete: boolean;
};

export type ApplySlSetReviewArgs = {
  manufacturerId: RowId;
  decisions: Array<{ slId: string; variantTypeId?: RowId; name?: string }>;
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
  if (args.decisions.some((d) => (d.name?.length ?? 0) > MAX_DECISION_NAME_LENGTH)) {
    throw new ConvexError("A name is too long. Shorten it and save again.");
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
    refused: [],
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
  const decisions: Array<{
    slId: string;
    label: string;
    variantTypeId?: RowId;
    name?: string;
  }> = [];
  for (const d of args.decisions) {
    if (seen.has(d.slId)) continue;
    seen.add(d.slId);
    const entry = inDoc.get(d.slId);
    if (!entry) {
      skip("notInReview", 1);
      continue;
    }
    const name = d.name?.trim();
    decisions.push({
      slId: entry.slId,
      label: entry.label,
      ...(d.variantTypeId ? { variantTypeId: d.variantTypeId } : {}),
      ...(name ? { name } : {}),
    });
  }
  // The operator's names, by id, sent with each chunk that files them.
  const nameOf = new Map(
    decisions.flatMap((d) => (d.name ? [[d.slId, d.name] as const] : [])),
  );
  const namesFor = (slIds: readonly string[]) => {
    const names = slIds.flatMap((slId) => {
      const name = nameOf.get(slId);
      return name ? [{ slId, name }] : [];
    });
    return names.length > 0 ? { names } : {};
  };

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

  const startedAt = await ctx.runMutation(internal.slSetReview.markSaveStarted, {
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
          ...namesFor(chunk),
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
        result.refused.push(...written.refused);
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
          refused: RefusedLine[];
        } = await ctx.runMutation(
          internal.slSetReview.createSlRowsUnderVariantType,
          {
            yearId,
            manufacturerId: args.manufacturerId,
            typeId,
            slIds: chunk,
            ...namesFor(chunk),
            createdByUserId: adminUserId,
          },
        );
        result.remaining = written.remaining;
        result.underType[written.role] += written.created;
        skip("nameTaken", written.nameTaken);
        skip("alreadyLinked", written.alreadyLinked);
        skip("invalid", written.invalid);
        skip("notInReview", written.notInReview);
        result.refused.push(...written.refused);
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

  // NEO-325 — ran to the end: no longer a partial save, whatever it left.
  // A failure here costs only the pill's wording ("save again" is harmless),
  // so it is logged, never thrown over a save that committed.
  if (!result.incomplete && startedAt !== null) {
    try {
      await ctx.runMutation(internal.slSetReview.markSaveFinished, {
        yearId,
        manufacturerId: args.manufacturerId,
        startedAt,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "sl_review_mark_finished_failed",
          adminUserId,
          manufacturerId: args.manufacturerId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
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
      refused: result.refused.length,
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
 * that variant type of one of the brand's BSC-linked sets), either with an
 * optional operator `name` (NEO-325). A line refused for its name stays in
 * the review and comes back in `refused`. Admin only; at most
 * `MAX_REVIEW_DECISIONS`. Additive: nothing is renamed or deleted.
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
