import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireAdmin } from "./auth";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";
import { inheritedTeamIds } from "./lib/selectorTeams";
import { initialSlots } from "./platformSlots";
import {
  checkCustomSelectorValue,
  selectorValueKey,
} from "./selectorSyncMatch";
import { unionChildren } from "./selectorSyncStore";

/**
 * NEO-237 (D11–D13) — "new on SportLots": the sets a marketplace lists under
 * a brand that NeonBinder has no set for yet, and the two things an operator
 * can do about one of them.
 *
 * ## What a candidate is
 *
 * `setCandidates` rows are written by the Sync Sets SportLots phase
 * (`reconcileSetCandidates` in selectorOptions.ts — the SOLE writer) after a
 * successful fetch of one brand's list: every returned entry that no row under
 * the brand already holds by id, and that is not a variant of a set NB already
 * names, grouped into roots with their longer siblings as `members`. They are
 * the marketplace's side of a comparison, not NB rows, so they live in their
 * own table and are read here by the pill on the Sets column.
 *
 * ## What this module does and does not do
 *
 *  - It READS pending roots for one brand, or for every brand under a year
 *    (the All Brands view), and never returns `skippedByUserId` — that is an
 *    audit field, not something the modal shows.
 *  - It CREATES a set from a root: one `setName` row with no marketplace ids
 *    and one `variantType` child called "Base" carrying the root's SportLots
 *    id, in one transaction (D13). The set row itself is NB's — the link sits
 *    on the Base, exactly where `BaseSetPicker` would put it, so the checklist
 *    fetch, the attach pane and the source chips all find it without a second
 *    concept. Members are NOT written: the next sync classifies them as
 *    variants of the set that now exists.
 *  - It SKIPS a root: `status: "skipped"`, which the reconcile preserves so
 *    the root stays hidden until upstream drops it.
 *
 * It never deletes or renames an NB row, never touches a candidate the
 * operator did not act on, and never reads a candidate's label as an NB
 * value: the operator names the set (the label is only the default).
 *
 * Every function is admin-gated, like every other set-builder door.
 */

/**
 * Rows the All Brands view may carry at once. A year is at most
 * `MAX_SL_BRANDS_PER_SYNC` brands × `MAX_SET_CANDIDATE_ROOTS` roots on paper;
 * in practice a full baseball year is a few hundred. A view past this is an
 * operator problem to work down brand by brand, not a list to ship to the
 * browser on every keystroke elsewhere in the tree.
 */
export const MAX_SET_CANDIDATES_PER_VIEW = 1000;

const candidateMemberValidator = v.object({
  id: v.string(),
  label: v.string(),
});

/**
 * The client's view of a candidate. Built by hand rather than from the table
 * so `skippedByUserId` and `skippedAt` can never leak through a `returns`
 * validator by accident — the audit fields are the reason this is not
 * `v.object(schema fields)`.
 */
const candidateViewFields = {
  _id: v.id("setCandidates"),
  _creationTime: v.number(),
  manufacturerId: v.id("selectorOptions"),
  side: v.union(v.literal("bsc"), v.literal("sportlots")),
  marketplaceId: v.string(),
  label: v.string(),
  members: v.array(candidateMemberValidator),
};

const candidateViewValidator = v.object(candidateViewFields);

/** The view's row also says WHICH brand it is offered under. */
const yearCandidateViewValidator = v.object({
  ...candidateViewFields,
  /** The brand row's display value, for the modal's per-brand grouping. */
  brand: v.string(),
});

export type SetCandidateView = {
  _id: Id<"setCandidates">;
  _creationTime: number;
  manufacturerId: Id<"selectorOptions">;
  side: "bsc" | "sportlots";
  marketplaceId: string;
  label: string;
  members: Array<{ id: string; label: string }>;
};

function toView(row: Doc<"setCandidates">): SetCandidateView {
  return {
    _id: row._id,
    _creationTime: row._creationTime,
    manufacturerId: row.manufacturerId,
    side: row.side,
    marketplaceId: row.marketplaceId,
    label: row.label,
    members: row.members,
  };
}

/**
 * Pending roots for one brand, in the order the writer stored them (sorted by
 * folded label — see the table comment). Bounded by the writer's
 * `MAX_SET_CANDIDATE_ROOTS`.
 */
async function pendingFor(
  ctx: QueryCtx,
  manufacturerId: Id<"selectorOptions">,
): Promise<Doc<"setCandidates">[]> {
  return await ctx.db
    .query("setCandidates")
    .withIndex("by_manufacturer_and_status", (q) =>
      q.eq("manufacturerId", manufacturerId).eq("status", "pending"),
    )
    .collect();
}

/**
 * The "N new on SportLots" pill's read for a brand's Sets column.
 */
export const getSetCandidates = query({
  args: { manufacturerId: v.id("selectorOptions") },
  returns: v.array(candidateViewValidator),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const rows = await pendingFor(ctx, args.manufacturerId);
    return rows.map(toView);
  },
});

/**
 * The same read for the All Brands view: every manufacturer under the year,
 * each brand's pending roots, each row stamped with the brand it is offered
 * under. Brands in display order (by folded value), roots in the writer's
 * order within a brand. Capped at `MAX_SET_CANDIDATES_PER_VIEW` rows.
 *
 * Returns `[]` for an id that is not a year: the view only exists under one.
 */
export const getSetCandidatesForYear = query({
  args: { yearId: v.id("selectorOptions") },
  returns: v.array(yearCandidateViewValidator),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const year = await ctx.db.get(args.yearId);
    if (!year || year.level !== "year") return [];

    const manufacturers = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "manufacturer").eq("parentId", args.yearId),
      )
      .collect();
    manufacturers.sort((a, b) =>
      selectorValueKey(a.value).localeCompare(selectorValueKey(b.value)),
    );

    const out: Array<SetCandidateView & { brand: string }> = [];
    for (const brand of manufacturers) {
      if (out.length >= MAX_SET_CANDIDATES_PER_VIEW) break;
      const rows = await pendingFor(ctx, brand._id);
      for (const row of rows) {
        if (out.length >= MAX_SET_CANDIDATES_PER_VIEW) break;
        out.push({ ...toView(row), brand: brand.value });
      }
    }
    return out;
  },
});

/**
 * D13 — a set and its Base from one root, in one transaction.
 *
 * Refusals, all `ConvexError` with a `code` the modal renders structurally
 * (never the raw message — production redacts it):
 *
 *  - `CUSTOM_VALUE_INVALID` `{ reason }` — the same per-level rule the
 *    "+ Custom" form applies (`checkCustomSelectorValue`), so a name that the
 *    column would refuse is refused here in the same sentence.
 *  - `SET_NAME_CLASH_AT_TARGET` `{ existingId, value }` — a sibling under the
 *    same brand already folds to this name (`selectorValueKey`, the fold every
 *    sync matcher uses). Report only: the operator changes the name or skips.
 *    Nothing is merged, because the existing set may well be a different
 *    product that happens to share a name.
 *  - `CUSTOM_EXISTS_ELSEWHERE` `{ matches }` — the name exists under a
 *    DIFFERENT manufacturer of the same year, the exact shape
 *    `addCustomSelectorOption` raises, from the same query
 *    (`findSelectorOptionElsewhere`), so the two doors can never disagree
 *    about what counts as a duplicate. Report only: there is no
 *    "create here anyway" from this dialog — a set SportLots files under this
 *    brand that NB already has under another one is a re-home question, and
 *    re-homing is the prefix's job, not this modal's.
 *
 * The insert mirrors `addCustomSelectorOption`'s: `platformData: {}` on the
 * set (NB owns the set; the marketplace link is on the Base), features from
 * the brand plus the level's own derivation, the brand's set-level team
 * copied down, `createdByUserId` from the caller's identity — never a client
 * argument. The Base gets its SportLots slot through `initialSlots` (slot key
 * `s0`, label = the root's label), `metadata.isBase: true`, no BSC facet (no
 * BSC id) and no `primaryPlatformId` (one slot; the lowest-numbered slot is
 * primary by default). Then the set's `children`, the brand's `children`
 * (set-union, never rebuilt), and the candidate is deleted — it has become a
 * row.
 */
export const createSetFromCandidate = mutation({
  args: {
    candidateId: v.id("setCandidates"),
    name: v.string(),
  },
  returns: v.object({
    setId: v.id("selectorOptions"),
    baseId: v.id("selectorOptions"),
  }),
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx);

    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) {
      throw new ConvexError(
        "That entry is gone — a sync has already filed it. Refresh and look again.",
      );
    }
    const brand = await ctx.db.get(candidate.manufacturerId);
    if (!brand || brand.level !== "manufacturer") {
      throw new ConvexError(
        "The brand this entry was listed under is gone. Refresh and look again.",
      );
    }

    const checked = checkCustomSelectorValue("setName", args.name);
    if (!checked.ok) {
      throw new ConvexError({
        code: "CUSTOM_VALUE_INVALID",
        reason: checked.reason,
      });
    }
    const value = checked.value;
    const key = selectorValueKey(value);

    // Sibling clash under the target brand — the fold every matcher uses.
    const siblings = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "setName").eq("parentId", brand._id),
      )
      .collect();
    const clash = siblings.find((s) => selectorValueKey(s.value) === key);
    if (clash) {
      throw new ConvexError({
        code: "SET_NAME_CLASH_AT_TARGET",
        existingId: clash._id,
        value: clash.value,
      });
    }

    // Cross-parent duplicate — the same query the "+ Custom" confirm offers
    // from, so the refusal shape is identical to `addCustomSelectorOption`'s.
    const matches = await ctx.runQuery(
      api.selectorOptions.findSelectorOptionElsewhere,
      { level: "setName", parentId: brand._id, value },
    );
    if (matches.length > 0) {
      throw new ConvexError({ code: "CUSTOM_EXISTS_ELSEWHERE", matches });
    }

    const now = Date.now();
    const brandTeamIds = inheritedTeamIds(brand);

    // 1. The set: NB's row, no marketplace ids.
    const setFeatures = {
      ...(brand.features ?? {}),
      ...deriveOwnLevelFeatures("setName", value),
    };
    const setId = await ctx.db.insert("selectorOptions", {
      level: "setName",
      value,
      platformData: {},
      parentId: brand._id,
      children: [],
      createdByUserId: userId,
      ...(Object.keys(setFeatures).length > 0 ? { features: setFeatures } : {}),
      ...(brandTeamIds ? { teamIds: brandTeamIds } : {}),
      lastUpdated: now,
    });

    // 2. The Base: the one row that carries the SportLots link.
    const slots = initialSlots({
      sportlots: [{ id: candidate.marketplaceId, label: candidate.label }],
    });
    const baseFeatures = {
      ...setFeatures,
      ...deriveOwnLevelFeatures("variantType", "Base"),
    };
    const baseId = await ctx.db.insert("selectorOptions", {
      level: "variantType",
      value: "Base",
      platformData: slots.platformData,
      platformLabels: slots.platformLabels,
      platformSlotSeq: slots.platformSlotSeq,
      parentId: setId,
      children: [],
      createdByUserId: userId,
      metadata: { isBase: true },
      ...(Object.keys(baseFeatures).length > 0
        ? { features: baseFeatures }
        : {}),
      ...(brandTeamIds ? { teamIds: [...brandTeamIds] } : {}),
      lastUpdated: now,
    });

    // 3. Parents' children caches, then the candidate is a row now.
    await ctx.db.patch(setId, { children: [baseId] });
    await ctx.db.patch(brand._id, {
      children: unionChildren(brand.children, [setId]),
    });
    await ctx.db.delete(candidate._id);

    return { setId, baseId };
  },
});

/**
 * Skip a root: it stays hidden until upstream stops listing it (the reconcile
 * keeps `skipped` rows as long as the marketplace still returns the id).
 * Idempotent — skipping a skipped row re-stamps who and when.
 */
export const skipSetCandidate = mutation({
  args: { candidateId: v.id("setCandidates") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx);
    const candidate = await ctx.db.get(args.candidateId);
    if (!candidate) {
      throw new ConvexError(
        "That entry is gone — a sync has already filed it. Refresh and look again.",
      );
    }
    await ctx.db.patch(candidate._id, {
      status: "skipped",
      skippedAt: Date.now(),
      skippedByUserId: userId,
    });
    return null;
  },
});
