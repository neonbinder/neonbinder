import {
  query,
  mutation,
  action,
  internalMutation,
} from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { getCurrentUserId, requireAdmin } from "./auth";
import {
  recordAdapterCall,
  newRequestId,
  classifyAdapterError,
} from "./observability";
import {
  deriveCardObservedFeatures,
  deriveOwnLevelFeatures,
  validateFeatureValue,
} from "./features/deriveCardFeatures";
import {
  generateListingTitle,
  generateListingDescription,
} from "./features/generateListing";
import { generateSku } from "./sku";
import { findSportForSelectorOption } from "./cardChecklist";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";

// ===== LEVEL VALIDATOR (reused across functions) =====
const levelValidator = v.union(
  v.literal("sport"),
  v.literal("year"),
  v.literal("manufacturer"),
  v.literal("setName"),
  v.literal("variantType"),
  v.literal("insert"),
  v.literal("parallel"),
);

const metadataValidator = v.optional(v.object({
  cardNumberPrefix: v.optional(v.string()),
  isInsert: v.optional(v.boolean()),
  isParallel: v.optional(v.boolean()),
}));

// NEO-24: marketplace-agnostic feature map (set-level + card-level).
// Keys come from `convex/features/expectedFeatures.ts`; values are strings.
const featuresValidator = v.optional(v.record(v.string(), v.string()));

type Level =
  | "sport"
  | "year"
  | "manufacturer"
  | "setName"
  | "variantType"
  | "insert"
  | "parallel";

// ===== QUERIES =====

export const getSelectorOptions = query({
  args: {
    level: levelValidator,
    parentId: v.optional(v.id("selectorOptions")),
  },
  returns: v.array(
    v.object({
      _id: v.id("selectorOptions"),
      _creationTime: v.number(),
      level: levelValidator,
      value: v.string(),
      platformData: v.object({
        bsc: v.optional(v.union(v.string(), v.array(v.string()))),
        sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
        sportlotsDisplay: v.optional(v.string()),
      }),
      platformLabels: v.optional(v.object({
        bsc: v.optional(v.record(v.string(), v.string())),
        sportlots: v.optional(v.record(v.string(), v.string())),
      })),
      primaryPlatformId: v.optional(v.object({
        bsc: v.optional(v.string()),
        sportlots: v.optional(v.string()),
      })),
      parentId: v.optional(v.id("selectorOptions")),
      children: v.optional(v.array(v.id("selectorOptions"))),
      isCustom: v.optional(v.boolean()),
      createdByUserId: v.optional(v.string()),
      metadata: metadataValidator,
      features: featuresValidator,
      lastUpdated: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const { level, parentId } = args;

    if (parentId) {
      return await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", level).eq("parentId", parentId),
        )
        .collect();
    } else {
      return await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", level).eq("parentId", undefined),
        )
        .collect();
    }
  },
});

// Returns all identifiers (display values + platform values) already used by
// inserts under the given setId, across every variantType sibling. Useful for
// excluding already-linked sets from reconciliation/picker dialogs.
export const getUsedInsertIdentifiersBySet = query({
  args: {
    setId: v.id("selectorOptions"),
    // When set, inserts under this variantType are *not* counted as "used".
    // ReconciliationModal passes its own variantTypeId so re-running the
    // same variantType still surfaces previously-saved rows (allowing the
    // user to prune them via the keep shelf). Items under sibling
    // variantTypes remain blocked so they aren't double-claimed.
    excludeVariantTypeId: v.optional(v.id("selectorOptions")),
  },
  returns: v.object({
    values: v.array(v.string()),
    slPlatformValues: v.array(v.string()),
    bscPlatformValues: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const variantTypes = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "variantType").eq("parentId", args.setId),
      )
      .collect();

    const values: string[] = [];
    const slPlatformValues: string[] = [];
    const bscPlatformValues: string[] = [];

    for (const vt of variantTypes) {
      if (args.excludeVariantTypeId && vt._id === args.excludeVariantTypeId) {
        continue;
      }
      const inserts = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "insert").eq("parentId", vt._id),
        )
        .collect();
      for (const ins of inserts) {
        values.push(ins.value);
        if (typeof ins.platformData.sportlots === "string") {
          slPlatformValues.push(ins.platformData.sportlots);
        }
        const bsc = ins.platformData.bsc;
        if (typeof bsc === "string") {
          bscPlatformValues.push(bsc);
        } else if (Array.isArray(bsc)) {
          bscPlatformValues.push(...bsc);
        }
      }
    }

    return { values, slPlatformValues, bscPlatformValues };
  },
});

// Returns the Base variantType row for a given setId, if one exists.
// Base is treated as a terminal node — it carries the SL/BSC platform
// mapping directly on the variantType row (no child insert). Used by
// VariantForm to seed the SL prefix filter when reconciling sibling
// Insert/Parallel variantTypes — the Base anchor's SportLots name is a
// tighter SL-side prefix than the BSC set name.
export const getBaseVariantBySet = query({
  args: { setId: v.id("selectorOptions") },
  returns: v.union(
    v.null(),
    v.object({
      value: v.string(),
      platformData: v.object({
        bsc: v.optional(v.union(v.string(), v.array(v.string()))),
        sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
        sportlotsDisplay: v.optional(v.string()),
      }),
      platformLabels: v.optional(v.object({
        bsc: v.optional(v.record(v.string(), v.string())),
        sportlots: v.optional(v.record(v.string(), v.string())),
      })),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const variantTypes = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "variantType").eq("parentId", args.setId),
      )
      .collect();
    const baseVariantType = variantTypes.find(
      (vt) => vt.value.toLowerCase().trim() === "base",
    );
    if (!baseVariantType) return null;
    return {
      value: baseVariantType.value,
      platformData: baseVariantType.platformData,
      ...(baseVariantType.platformLabels !== undefined
        ? { platformLabels: baseVariantType.platformLabels }
        : {}),
    };
  },
});

export const getSelectorOptionById = query({
  args: { id: v.id("selectorOptions") },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("selectorOptions"),
      _creationTime: v.number(),
      level: levelValidator,
      value: v.string(),
      platformData: v.object({
        bsc: v.optional(v.union(v.string(), v.array(v.string()))),
        sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
        sportlotsDisplay: v.optional(v.string()),
      }),
      platformLabels: v.optional(v.object({
        bsc: v.optional(v.record(v.string(), v.string())),
        sportlots: v.optional(v.record(v.string(), v.string())),
      })),
      primaryPlatformId: v.optional(v.object({
        bsc: v.optional(v.string()),
        sportlots: v.optional(v.string()),
      })),
      parentId: v.optional(v.id("selectorOptions")),
      children: v.optional(v.array(v.id("selectorOptions"))),
      isCustom: v.optional(v.boolean()),
      createdByUserId: v.optional(v.string()),
      metadata: metadataValidator,
      features: featuresValidator,
      lastUpdated: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    return await ctx.db.get(args.id);
  },
});

export const findByLevelAndValue = query({
  args: {
    level: levelValidator,
    value: v.string(),
    parentId: v.optional(v.id("selectorOptions")),
  },
  returns: v.union(
    v.null(),
    v.object({
      _id: v.id("selectorOptions"),
      _creationTime: v.number(),
      level: levelValidator,
      value: v.string(),
      platformData: v.object({
        bsc: v.optional(v.union(v.string(), v.array(v.string()))),
        sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
        sportlotsDisplay: v.optional(v.string()),
      }),
      platformLabels: v.optional(v.object({
        bsc: v.optional(v.record(v.string(), v.string())),
        sportlots: v.optional(v.record(v.string(), v.string())),
      })),
      primaryPlatformId: v.optional(v.object({
        bsc: v.optional(v.string()),
        sportlots: v.optional(v.string()),
      })),
      parentId: v.optional(v.id("selectorOptions")),
      children: v.optional(v.array(v.id("selectorOptions"))),
      isCustom: v.optional(v.boolean()),
      createdByUserId: v.optional(v.string()),
      metadata: metadataValidator,
      features: featuresValidator,
      lastUpdated: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const options = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", args.level).eq("parentId", args.parentId),
      )
      .collect();

    const normalizedTarget = args.value.toLowerCase().trim();
    return options.find((o) => o.value.toLowerCase().trim() === normalizedTarget) || null;
  },
});

export const getAncestorChain = query({
  args: { id: v.id("selectorOptions") },
  returns: v.array(
    v.object({
      _id: v.id("selectorOptions"),
      level: levelValidator,
      value: v.string(),
      platformData: v.object({
        bsc: v.optional(v.union(v.string(), v.array(v.string()))),
        sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
        sportlotsDisplay: v.optional(v.string()),
      }),
      metadata: metadataValidator,
      // NEO-24: surface ancestor features so callers (commitCardChecklist
      // inheritance merge, SetFeaturesPanel) can resolve effective values
      // without a second round-trip.
      features: featuresValidator,
      isCustom: v.optional(v.boolean()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const chain: Array<{
      _id: Id<"selectorOptions">;
      level: Level;
      value: string;
      platformData: { bsc?: string | string[]; sportlots?: string };
      metadata?: { cardNumberPrefix?: string; isInsert?: boolean; isParallel?: boolean };
      features?: Record<string, string>;
      isCustom?: boolean;
    }> = [];
    let currentId: Id<"selectorOptions"> | undefined = args.id;

    while (currentId) {
      const option: any = await ctx.db.get(currentId);
      if (!option) break;
      chain.unshift({
        _id: option._id,
        level: option.level,
        value: option.value,
        platformData: option.platformData || {},
        metadata: option.metadata,
        features: option.features,
        isCustom: option.isCustom,
      });
      currentId = option.parentId;
    }

    return chain;
  },
});

// Walk a resolved ancestor chain (output of `getAncestorChain`) and decide
// whether any node — including the leaf — is user-created. When this returns
// true, marketplace adapters (BSC, SportLots) must NOT be called for this
// subtree: they have no concept of a custom node and would either widen the
// query to an unrelated superset (per the historical BSC fallback) or fail
// outright. See NEO-22.
function isCustomSubtree(
  chain: Array<{ isCustom?: boolean }>,
): boolean {
  return chain.some((row) => row.isCustom === true);
}

export const getCardChecklist = query({
  args: { selectorOptionId: v.id("selectorOptions") },
  returns: v.array(
    v.object({
      _id: v.id("cardChecklist"),
      _creationTime: v.number(),
      selectorOptionId: v.id("selectorOptions"),
      cardNumber: v.string(),
      cardName: v.string(),
      // NEO-26: DEPRECATED — kept in returns validator only so legacy
      // rows that pre-date the `backfillTeamToOnCardIds` migration
      // still round-trip without `ReturnsValidationError`. No code
      // path writes to it. Follow-up PR removes once backfill is
      // confirmed clean on prod + dev.
      team: v.optional(v.string()),
      playerIds: v.optional(v.array(v.id("players"))),
      teamOnCardIds: v.optional(v.array(v.id("teams"))),
      // NEO-90: set once the BSC per-card team-enrichment queue has
      // checked this card, regardless of outcome (see schema.ts).
      teamCheckDoneAt: v.optional(v.number()),
      attributes: v.optional(v.array(v.string())),
      isRookie: v.optional(v.boolean()),
      isRelic: v.optional(v.boolean()),
      printRun: v.optional(v.number()),
      autographType: v.optional(v.string()),
      cardVariation: v.optional(v.string()),
      // NEO-25: marketplace-agnostic listing strings (see schema.ts).
      listingTitle: v.optional(v.string()),
      listingDescription: v.optional(v.string()),
      imageUrls: v.optional(v.object({
        front: v.optional(v.string()),
        back: v.optional(v.string()),
      })),
      platformData: v.object({
        bsc: v.optional(v.string()),
        sportlots: v.optional(v.string()),
      }),
      sourcePlatformIds: v.optional(v.object({
        bsc: v.optional(v.string()),
        sportlots: v.optional(v.string()),
      })),
      isCustom: v.optional(v.boolean()),
      pendingPlayerNames: v.optional(v.array(v.string())),
      pendingTeamNames: v.optional(v.array(v.string())),
      features: featuresValidator,
      // NEO-91: cross-marketplace SKU (see convex/sku.ts).
      sku: v.optional(v.string()),
      sortOrder: v.number(),
      lastUpdated: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    return await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();
  },
});

// NEO-85: structural deep-equal for the small plain-value objects/arrays we
// store on selectorOptions (platformData, children id arrays).
// Leaves are string | number | boolean | null; containers are arrays and plain
// objects. Used to skip no-op ctx.db.patch calls: in Convex, patching a row —
// even with byte-identical data — invalidates every query that read it, which
// re-renders and reflows the SetSelector columns under Maestro's coordinate
// taps (the weeks-long dropped-tap flake). Order-sensitive for arrays; our
// syncs write a deterministic order, so identical syncs compare equal.
function valuesDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!valuesDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (
        !valuesDeepEqual(
          (a as Record<string, unknown>)[key],
          (b as Record<string, unknown>)[key],
        )
      ) {
        return false;
      }
    }
    return true;
  }
  return false;
}

// ===== MUTATIONS =====

export const storeSelectorOptions = mutation({
  args: {
    level: levelValidator,
    options: v.array(
      v.object({
        value: v.string(),
        platformData: v.object({
          bsc: v.optional(v.union(v.string(), v.array(v.string()))),
          sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
          sportlotsDisplay: v.optional(v.string()),
        }),
      }),
    ),
    parentId: v.optional(v.id("selectorOptions")),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    optionsCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const { level, options, parentId } = args;

    // NEO-71-74: every option in this batch shares one parentId — fetch its
    // already-complete `features` snapshot once and copy it onto every
    // fresh insert below (write-once feature snapshots: see
    // deriveOwnLevelFeatures in convex/features/deriveCardFeatures.ts).
    const parentFeatures: Record<string, string> | undefined = parentId
      ? (await ctx.db.get(parentId))?.features
      : undefined;

    // Get existing non-custom options for this level and parent
    const existingOptions = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", level).eq("parentId", parentId),
      )
      .collect();

    // Build a map of existing options by normalized value
    const existingByValue = new Map<
      string,
      (typeof existingOptions)[0]
    >();
    for (const opt of existingOptions) {
      existingByValue.set(opt.value.toLowerCase().trim(), opt);
    }

    // Upsert: update existing, insert new
    const processedValues = new Set<string>();
    const insertedIds: Id<"selectorOptions">[] = [];

    // Levels where downstream fetches require a BSC slug. SL is excluded
    // — its adapter doesn't filter on setName and does its own DB lookup
    // for the radio-button ID, so a setName row legitimately can lack
    // platformData.sportlots. A missing BSC slug at sport/year/setName
    // *will* cause fetchCardChecklist / fetchRawOptions to fail the
    // precondition, so warn early to make the cascade upstream visible.
    const BSC_REQUIRED_LEVELS = new Set(["sport", "year", "setName"]);
    const warnIfIncomplete = (
      rowId: Id<"selectorOptions"> | "new",
      value: string,
      pd: { bsc?: string | string[]; sportlots?: string | string[] },
    ) => {
      if (!BSC_REQUIRED_LEVELS.has(level)) return;
      if (pd.bsc) return;
      console.warn(
        `[storeSelectorOptions] row missing BSC platform slug — level=${level} ` +
          `value=${value} id=${rowId}. Downstream BSC fetches will hit the ` +
          `missing-slug precondition.`,
      );
    };

    for (const option of options) {
      const normalizedValue = option.value.toLowerCase().trim();
      processedValues.add(normalizedValue);

      const existing = existingByValue.get(normalizedValue);
      if (existing) {
        // Merge platformData onto existing (preserves custom entries)
        const mergedPlatformData = {
          ...existing.platformData,
          ...option.platformData,
        };
        warnIfIncomplete(existing._id, option.value, mergedPlatformData);

        // NEO-85: only patch when the merged data actually differs from what's
        // stored. A no-op patch still invalidates every query that read this
        // row, re-rendering + reflowing the SetSelector columns for nothing
        // (forensics: `items-changed sameContent=true`). `lastUpdated` is a
        // "data last changed" marker — never displayed or used for staleness
        // (the FE "Last synced" reads cardChecklist.lastUpdated) — so skipping
        // the bump on an unchanged sync is correct.
        const platformDataChanged = !valuesDeepEqual(
          mergedPlatformData,
          existing.platformData,
        );

        if (platformDataChanged) {
          await ctx.db.patch(existing._id, {
            platformData: mergedPlatformData,
            lastUpdated: Date.now(),
          });
        }
        // Always keep the row in the parent's children set, whether or not we
        // patched it — skipping the patch must not drop it from the ordering.
        insertedIds.push(existing._id);
      } else {
        warnIfIncomplete("new", option.value, option.platformData);
        const features = {
          ...(parentFeatures ?? {}),
          ...deriveOwnLevelFeatures(level, option.value),
        };
        const id = await ctx.db.insert("selectorOptions", {
          level,
          value: option.value,
          platformData: option.platformData,
          parentId,
          children: [],
          ...(Object.keys(features).length > 0 ? { features } : {}),
          lastUpdated: Date.now(),
        });
        insertedIds.push(id);
      }
    }

    // Delete old non-custom options that weren't in the new set
    // Only delete if we actually received new options — an empty sync should not wipe data
    if (options.length > 0) {
      for (const existing of existingOptions) {
        const normalizedValue = existing.value.toLowerCase().trim();
        if (!processedValues.has(normalizedValue) && !existing.isCustom) {
          await ctx.db.delete(existing._id);
        }
      }
    }

    // Update parent's children array
    if (parentId && insertedIds.length > 0) {
      // Get remaining custom options to include in children
      const customIds = existingOptions
        .filter(
          (o) =>
            o.isCustom &&
            !processedValues.has(o.value.toLowerCase().trim()),
        )
        .map((o) => o._id);
      const newChildren = [...insertedIds, ...customIds];
      // NEO-85: only rewrite children when the array actually changed (same
      // ids, same order). A no-op rewrite invalidates every reader of the
      // parent row for nothing.
      const parent = await ctx.db.get(parentId);
      if (parent && !valuesDeepEqual(parent.children ?? [], newChildren)) {
        await ctx.db.patch(parentId, { children: newChildren });
      }
    }

    return {
      success: true,
      message: `Successfully stored ${insertedIds.length} ${level} options`,
      optionsCount: insertedIds.length,
    };
  },
});

export const addCustomSelectorOption = mutation({
  args: {
    level: levelValidator,
    value: v.string(),
    parentId: v.optional(v.id("selectorOptions")),
    userId: v.optional(v.string()),
  },
  returns: v.id("selectorOptions"),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const { level, value, parentId, userId } = args;

    // NEO-71-74: fetch the parent once, up front — reused both for the
    // fresh row's copy-down `features` snapshot below and for the
    // children-array update at the end (same read count as before, just
    // reordered; the insert doesn't touch the parent doc, so this stays
    // accurate throughout the mutation).
    const parent = parentId ? await ctx.db.get(parentId) : null;

    // Check for duplicate by normalized value
    const existing = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", level).eq("parentId", parentId),
      )
      .collect();

    const normalizedValue = value.toLowerCase().trim();
    const duplicate = existing.find(
      (o) => o.value.toLowerCase().trim() === normalizedValue,
    );

    if (duplicate) {
      // Typing a value that already exists — whether it came from a marketplace
      // sync or a prior custom add — is treated exactly like selecting it from
      // the list: we resolve to the existing row rather than minting a
      // duplicate. This keeps the custom field forgiving (entering "Football"
      // in the Sport custom box behaves like searching for Football) AND
      // prevents a custom row from shadowing synced data — which is invalid,
      // since a custom parent forces every descendant custom (no sync is
      // possible under it). The FE drives the actual selection/drill; this is
      // the idempotent + race-safe backstop.
      return duplicate._id;
    }

    const features = {
      ...(parent?.features ?? {}),
      ...deriveOwnLevelFeatures(level, value),
    };

    const id = await ctx.db.insert("selectorOptions", {
      level,
      value,
      platformData: {},
      parentId,
      children: [],
      isCustom: true,
      createdByUserId: userId,
      ...(Object.keys(features).length > 0 ? { features } : {}),
      lastUpdated: Date.now(),
    });

    // Update parent's children array
    if (parentId && parent) {
      const newChildren = [...(parent.children || []), id];
      // NEO-85: guard the rewrite for consistency with storeSelectorOptions.
      // `id` is a fresh insert so this practically always differs, but the
      // guard keeps the no-op-patch discipline uniform across both paths.
      if (!valuesDeepEqual(parent.children ?? [], newChildren)) {
        await ctx.db.patch(parentId, { children: newChildren });
      }
    }

    return id;
  },
});

// ===== NEO-6 phase 1: multi-source attachment =====
//
// Caps. Both are admin-gated so they're not a security boundary — they're
// guard rails against operator-induced footguns (fan-out DoS against the
// SportLots adapter, label-quality drift, etc).
const MAX_ATTACHED_PER_SIDE = 10;
const MAX_LABEL_LENGTH = 200;
//
// A canonical NeonBinder variant (variantType / insert / parallel row) can
// map to multiple BSC and/or SL set IDs. The reconciliation primary is
// recorded in `primaryPlatformId`; operator-attached extras live alongside
// it in `platformData.<side>` (as an array) with human-readable labels in
// `platformLabels.<side>`. The mutations below are the only path operators
// use to attach / detach / rename extras — they patch a single row, and
// they refuse to touch the primary (which is owned by reconciliation).

const platformSideValidator = v.union(
  v.literal("bsc"),
  v.literal("sportlots"),
);

// Normalize platformData side to an array. Mirrors the helper in
// setReconciliation.ts but kept local to avoid a cross-file import.
function pdSideToArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function packPdSide(ids: string[]): string | string[] | undefined {
  if (ids.length === 0) return undefined;
  if (ids.length === 1) return ids[0];
  return ids;
}

/**
 * Attach one or more BSC/SL set IDs to an existing canonical row, with
 * editable human labels. Skips IDs already attached (including the
 * primary). Only valid on variant levels (variantType / insert / parallel).
 */
export const attachPlatformIds = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    additions: v.object({
      bsc: v.optional(
        v.array(v.object({ id: v.string(), label: v.string() })),
      ),
      sportlots: v.optional(
        v.array(v.object({ id: v.string(), label: v.string() })),
      ),
    }),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    attachedCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(args.selectorOptionId);
    if (!row) {
      throw new Error(
        `selectorOptions row not found: ${args.selectorOptionId}`,
      );
    }
    if (
      row.level !== "variantType" &&
      row.level !== "insert" &&
      row.level !== "parallel"
    ) {
      throw new Error(
        `attachPlatformIds only valid on variantType/insert/parallel rows (got level=${row.level})`,
      );
    }

    // Validate every label and id up-front so a malformed batch fails
    // atomically instead of half-applying. Labels must be non-empty after
    // trim and within MAX_LABEL_LENGTH — same shape `renamePlatformLabel`
    // enforces. Empty IDs are silently skipped (treated as no-op).
    for (const side of ["bsc", "sportlots"] as const) {
      const additions = args.additions[side] ?? [];
      for (const { id, label } of additions) {
        if (!id) continue;
        const trimmed = label.trim();
        if (!trimmed) {
          throw new Error(
            `attachPlatformIds: label is required (side=${side}, id=${id})`,
          );
        }
        if (trimmed.length > MAX_LABEL_LENGTH) {
          throw new Error(
            `attachPlatformIds: label exceeds ${MAX_LABEL_LENGTH} chars (side=${side}, id=${id})`,
          );
        }
      }
    }

    const mergedPD: { bsc?: string | string[]; sportlots?: string | string[] } = {
      bsc: row.platformData.bsc,
      sportlots: row.platformData.sportlots,
    };
    const mergedLabels: {
      bsc?: Record<string, string>;
      sportlots?: Record<string, string>;
    } = {
      bsc: { ...(row.platformLabels?.bsc ?? {}) },
      sportlots: { ...(row.platformLabels?.sportlots ?? {}) },
    };

    let attached = 0;
    for (const side of ["bsc", "sportlots"] as const) {
      const additions = args.additions[side] ?? [];
      if (additions.length === 0) continue;
      const current = pdSideToArray(mergedPD[side]);
      const currentSet = new Set(current);
      for (const { id, label } of additions) {
        if (!id) continue;
        if (!currentSet.has(id)) {
          if (current.length >= MAX_ATTACHED_PER_SIDE) {
            throw new Error(
              `attachPlatformIds: cap of ${MAX_ATTACHED_PER_SIDE} attached IDs per side reached (side=${side})`,
            );
          }
          current.push(id);
          currentSet.add(id);
          attached += 1;
        }
        // Label overwrites are intentional — operator may re-attach with a
        // cleaner label and expect it to stick. We've already validated
        // non-empty + length in the pass above.
        mergedLabels[side]![id] = label.trim();
      }
      mergedPD[side] = packPdSide(current);
    }

    // Strip empty label objects so we don't write `{ bsc: {} }`.
    const labelsPatch: {
      bsc?: Record<string, string>;
      sportlots?: Record<string, string>;
    } = {};
    if (Object.keys(mergedLabels.bsc ?? {}).length > 0) {
      labelsPatch.bsc = mergedLabels.bsc;
    }
    if (Object.keys(mergedLabels.sportlots ?? {}).length > 0) {
      labelsPatch.sportlots = mergedLabels.sportlots;
    }

    await ctx.db.patch(row._id, {
      platformData: mergedPD,
      platformLabels:
        Object.keys(labelsPatch).length > 0 ? labelsPatch : undefined,
      lastUpdated: Date.now(),
    });

    return {
      success: true,
      message: `Attached ${attached} new platform ID(s)`,
      attachedCount: attached,
    };
  },
});

/**
 * Detach a single non-primary platform ID. Refuses to detach the
 * reconciliation primary (operator must re-run set reconciliation to
 * change that). Removes the associated label entry as well.
 */
export const detachPlatformId = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    side: platformSideValidator,
    id: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(args.selectorOptionId);
    if (!row) {
      throw new Error(
        `selectorOptions row not found: ${args.selectorOptionId}`,
      );
    }
    const current = pdSideToArray(row.platformData[args.side]);
    const primary =
      row.primaryPlatformId?.[args.side] ?? current[0];
    if (args.id === primary) {
      throw new Error(
        `Refusing to detach the reconciliation primary (${args.side}=${args.id}). ` +
          `Re-run set reconciliation to change the primary.`,
      );
    }
    if (!current.includes(args.id)) {
      return { success: true, message: "Nothing to detach (id not attached)" };
    }
    const remaining = current.filter((x) => x !== args.id);
    const newLabels = { ...(row.platformLabels?.[args.side] ?? {}) };
    delete newLabels[args.id];

    const labelsPatch: {
      bsc?: Record<string, string>;
      sportlots?: Record<string, string>;
    } = { ...(row.platformLabels ?? {}) };
    if (Object.keys(newLabels).length > 0) {
      labelsPatch[args.side] = newLabels;
    } else {
      delete labelsPatch[args.side];
    }

    await ctx.db.patch(row._id, {
      platformData: {
        ...row.platformData,
        [args.side]: packPdSide(remaining),
      },
      platformLabels:
        Object.keys(labelsPatch).length > 0 ? labelsPatch : undefined,
      lastUpdated: Date.now(),
    });
    return { success: true, message: "Detached" };
  },
});

/**
 * Rename a platformLabels entry. Works for primary OR extras — the label
 * is presentation-only, so renaming the primary's label is harmless.
 */
export const renamePlatformLabel = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    side: platformSideValidator,
    id: v.string(),
    label: v.string(),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(args.selectorOptionId);
    if (!row) {
      throw new Error(
        `selectorOptions row not found: ${args.selectorOptionId}`,
      );
    }
    const attached = pdSideToArray(row.platformData[args.side]);
    if (!attached.includes(args.id)) {
      throw new Error(
        `Cannot rename label for unattached id (${args.side}=${args.id})`,
      );
    }
    const trimmed = args.label.trim();
    if (!trimmed) {
      throw new Error("Label cannot be empty");
    }

    const sideLabels = {
      ...(row.platformLabels?.[args.side] ?? {}),
      [args.id]: trimmed,
    };
    const labelsPatch: {
      bsc?: Record<string, string>;
      sportlots?: Record<string, string>;
    } = { ...(row.platformLabels ?? {}) };
    labelsPatch[args.side] = sideLabels;

    await ctx.db.patch(row._id, {
      platformLabels: labelsPatch,
      lastUpdated: Date.now(),
    });
    return { success: true, message: "Renamed" };
  },
});

/**
 * Validator for the rich per-card payload that storeCardChecklist accepts.
 * Mirrors the shape returned by fetchBscChecklist + fetchSportLotsChecklist
 * after reconciliation. Player/team strings have already been resolved to
 * IDs by the time this runs (commitCardChecklist handles findOrCreate and
 * passes IDs in here).
 */
const richChecklistCardValidator = v.object({
  cardNumber: v.string(),
  cardName: v.string(),
  // NEO-26: free-text `team` removed; callers pass `teamOnCardIds[]`.
  playerIds: v.optional(v.array(v.id("players"))),
  teamOnCardIds: v.optional(v.array(v.id("teams"))),
  attributes: v.optional(v.array(v.string())),
  isRookie: v.optional(v.boolean()),
  isRelic: v.optional(v.boolean()),
  printRun: v.optional(v.number()),
  autographType: v.optional(v.string()),
  cardVariation: v.optional(v.string()),
  platformData: v.object({
    bsc: v.optional(v.string()),
    sportlots: v.optional(v.string()),
  }),
});

/**
 * Natural-numeric comparator for card numbers.
 *
 * Card numbers are short strings like "1", "1a", "1b", "2", "10", "DK-1",
 * "9001". Lexicographic sort gives "10" before "2"; pure numeric sort can't
 * handle the letter suffixes. This splits each number into a leading-digit
 * portion and a tail, comparing numerically first then lexicographically on
 * the tail.
 *
 * Pure-letter card numbers (e.g. "DK-1") with no leading digits fall back
 * to lexicographic comparison against each other and sort AFTER any numeric
 * card. Custom cards like "9001" naturally end up at the bottom relative
 * to typical marketplace card numbers (1-500), which matches user
 * expectations for an appended custom slot.
 */
/**
 * Walk a selectorOptions node's parent chain to find its setName ancestor's
 * display value (e.g. "Chrome"). Used only for listing-title/description
 * generation (NEO-24/71-74) — every other consumer of the ancestor chain
 * already had its own reason to walk it (e.g. commitCardChecklist's
 * setNameAncestorId), so this stays a small, focused helper rather than a
 * general-purpose ancestor-chain utility.
 */
async function findSetNameValue(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<any> } },
  node: any,
): Promise<string | undefined> {
  if (!node) return undefined;
  if (node.level === "setName") return node.value;
  let cursorId: Id<"selectorOptions"> | undefined = node.parentId;
  while (cursorId) {
    const n = await ctx.db.get(cursorId);
    if (!n) break;
    if (n.level === "setName") return n.value;
    cursorId = n.parentId;
  }
  return undefined;
}

function compareCardNumbers(a: string, b: string): number {
  const aMatch = a.match(/^(\d+)(.*)/);
  const bMatch = b.match(/^(\d+)(.*)/);
  if (aMatch && bMatch) {
    const aNum = parseInt(aMatch[1], 10);
    const bNum = parseInt(bMatch[1], 10);
    if (aNum !== bNum) return aNum - bNum;
    return aMatch[2].localeCompare(bMatch[2]);
  }
  if (aMatch && !bMatch) return -1;
  if (!aMatch && bMatch) return 1;
  return a.localeCompare(b);
}

/**
 * Re-stamp `sortOrder` on every row in this selectorOption's checklist so
 * the values reflect natural cardNumber order. Called at the end of any
 * mutation that adds/updates rows so the client can sort by sortOrder and
 * trust the result without re-doing the natural-sort itself.
 *
 * Note: this writes to every row whose new sortOrder differs from current,
 * which can be many writes after a fresh marketplace commit. Convex bundles
 * these into the same transaction, so query subscribers see exactly one
 * invalidation regardless of how many rows changed.
 */
async function restampCardChecklistSortOrders(
  ctx: { db: { query: any; patch: any } },
  selectorOptionId: Id<"selectorOptions">,
): Promise<void> {
  const all = await ctx.db
    .query("cardChecklist")
    .withIndex("by_selector_option", (q: any) =>
      q.eq("selectorOptionId", selectorOptionId),
    )
    .collect();
  const sorted = [...all].sort((a, b) => compareCardNumbers(a.cardNumber, b.cardNumber));
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].sortOrder !== i) {
      await ctx.db.patch(sorted[i]._id, { sortOrder: i });
    }
  }
}

export const storeCardChecklist = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    cards: v.array(richChecklistCardValidator),
  },
  returns: v.object({
    success: v.boolean(),
    count: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const { selectorOptionId, cards } = args;

    // Get existing cards for this variant
    const existingCards = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", selectorOptionId),
      )
      .collect();

    const existingByNumber = new Map<string, (typeof existingCards)[0]>();
    for (const card of existingCards) {
      existingByNumber.set(card.cardNumber, card);
    }

    const processedNumbers = new Set<string>();

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      processedNumbers.add(card.cardNumber);

      const existing = existingByNumber.get(card.cardNumber);
      if (existing) {
        // Merge platform data — keep prior IDs if the new payload omits one side
        const mergedPlatformData = {
          ...existing.platformData,
          ...card.platformData,
        };
        await ctx.db.patch(existing._id, {
          cardName: card.cardName,
          // NEO-26: legacy `team` removed; only teamOnCardIds[] is written.
          playerIds: card.playerIds,
          teamOnCardIds: card.teamOnCardIds,
          attributes: card.attributes,
          isRookie: card.isRookie,
          isRelic: card.isRelic,
          printRun: card.printRun,
          autographType: card.autographType,
          cardVariation: card.cardVariation,
          platformData: mergedPlatformData,
          sortOrder: i,
          lastUpdated: Date.now(),
        });
      } else {
        await ctx.db.insert("cardChecklist", {
          selectorOptionId,
          cardNumber: card.cardNumber,
          cardName: card.cardName,
          // NEO-26: legacy `team` removed; only teamOnCardIds[] is written.
          playerIds: card.playerIds,
          teamOnCardIds: card.teamOnCardIds,
          attributes: card.attributes,
          isRookie: card.isRookie,
          isRelic: card.isRelic,
          printRun: card.printRun,
          autographType: card.autographType,
          cardVariation: card.cardVariation,
          platformData: card.platformData,
          sortOrder: i,
          lastUpdated: Date.now(),
        });
      }
    }

    // Delete non-custom cards that weren't in the new set
    for (const existing of existingCards) {
      if (!processedNumbers.has(existing.cardNumber) && !existing.isCustom) {
        await ctx.db.delete(existing._id);
      }
    }

    // Re-stamp sortOrder by natural cardNumber so custom cards (which were
    // inserted with a snapshot-of-empty-checklist sortOrder of 0) interleave
    // correctly with the just-committed marketplace rows. Without this, a
    // custom card added when the checklist was empty stays at sortOrder=0
    // and ties with marketplace card index 0, making the visual ordering
    // unpredictable.
    await restampCardChecklistSortOrders(ctx, selectorOptionId);

    return { success: true, count: cards.length };
  },
});

export const addCustomCard = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    cardNumber: v.string(),
    cardName: v.string(),
    // NEO-26: legacy `team: v.string()` removed. Callers that have a
    // team display string should put it in `teams: [string]` so the
    // commitCardChecklist resolution path can turn it into a teams
    // entity link via the UnknownEntitiesDialog confirmation flow.
    attributes: v.optional(v.array(v.string())),
    // Player names the user wants linked to this custom card. Surface as
    // unknownPlayers on the next fetchCardChecklist run so the user can
    // confirm Wikidata enrichment via the UnknownEntitiesDialog.
    // commitCardChecklist clears confirmed names from pendingPlayerNames
    // so the dialog doesn't re-prompt for the same player.
    players: v.optional(v.array(v.string())),
    // Team names — same flow as players, but for the teams table.
    teams: v.optional(v.array(v.string())),
  },
  returns: v.id("cardChecklist"),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const pendingPlayerNames = args.players
      ?.map((n) => n.trim())
      .filter((n) => n.length > 0);
    const pendingTeamNames = args.teams
      ?.map((n) => n.trim())
      .filter((n) => n.length > 0);

    // NEO-71-74: the selectorOption node this card lives under already
    // carries a complete, self-contained `features` snapshot (copy-down
    // happens once, at that node's own creation — see storeSelectorOptions/
    // addCustomSelectorOption/storeReconciledOptions). No ancestor walk
    // needed: a single read of this one node is the full resolved
    // inheritance. Precedence = that snapshot < card-observed facts (a fact
    // seen on THIS card, e.g. it's a rookie, wins).
    const parentNode = await ctx.db.get(args.selectorOptionId);
    const inheritedFeatures: Record<string, string> = parentNode?.features ?? {};
    const mergedFeatures: Record<string, string> = {
      ...inheritedFeatures,
      ...deriveCardObservedFeatures({ attributes: args.attributes }),
    };
    const featuresOrUndefined: Record<string, string> | undefined =
      Object.keys(mergedFeatures).length > 0 ? mergedFeatures : undefined;

    // NEO-24/71-74: write-once listing title/description, generated once
    // here at creation time from whatever's already known, then freely
    // editable afterward (same model as every other default this session —
    // never regenerated automatically once a row exists). Pending player
    // names are used as-is for display purposes even though they aren't
    // resolved to real player rows yet (that happens later, if confirmed,
    // via commitCardChecklist) — the operator typed a real name, so it's
    // the right thing to show regardless of reconciliation state.
    const setNameValue = await findSetNameValue(ctx, parentNode);
    const listingInputs = {
      cardNumber: args.cardNumber,
      playerNames: pendingPlayerNames,
      year: mergedFeatures.season,
      manufacturer: mergedFeatures.manufacturer,
      setName: setNameValue,
      parallelName: mergedFeatures.parallelName,
      isRookie: (args.attributes ?? []).includes("RC"),
      isRelic: (args.attributes ?? []).includes("RELIC"),
      autographed: mergedFeatures.autographed,
      shortPrint: mergedFeatures.shortPrint,
    };

    // Insert with a placeholder sortOrder; restampCardChecklistSortOrders
    // below assigns the correct natural-cardNumber position. This way a
    // user can add #42 to a set already containing #1..#100 and the new
    // row slots between #41 and #43 instead of appended at the end.
    const id = await ctx.db.insert("cardChecklist", {
      selectorOptionId: args.selectorOptionId,
      cardNumber: args.cardNumber,
      cardName: args.cardName,
      // NEO-26: legacy `team` removed. The team string supplied via
      // `args.teams` becomes a pendingTeamName above, then a teams
      // entity link after the user confirms in UnknownEntitiesDialog.
      attributes: args.attributes,
      platformData: {},
      isCustom: true,
      ...(pendingPlayerNames && pendingPlayerNames.length > 0
        ? { pendingPlayerNames }
        : {}),
      ...(pendingTeamNames && pendingTeamNames.length > 0
        ? { pendingTeamNames }
        : {}),
      ...(featuresOrUndefined ? { features: featuresOrUndefined } : {}),
      listingTitle: generateListingTitle(listingInputs),
      listingDescription: generateListingDescription(listingInputs),
      sortOrder: 0,
      lastUpdated: Date.now(),
    });

    await restampCardChecklistSortOrders(ctx, args.selectorOptionId);

    // NEO-91: same insert-then-patch SKU generation as commitCardChecklist.
    const sport = await findSportForSelectorOption(ctx, args.selectorOptionId);
    await ctx.db.patch(id, {
      sku: generateSku({
        sport: sport ?? "",
        year: mergedFeatures.season ?? "",
        setName: setNameValue ?? "",
        cardNumber: args.cardNumber,
        uniqueSuffix: crypto.randomUUID(),
      }),
    });

    return id;
  },
});

export const updateCard = mutation({
  args: {
    id: v.id("cardChecklist"),
    cardNumber: v.optional(v.string()),
    cardName: v.optional(v.string()),
    // NEO-26: full-replacement teams patch. Callers pass the entire
    // desired array of team entity ids (or omit to leave untouched).
    // Empty array clears the link; the legacy free-text `team` field
    // was removed in this PR.
    teamOnCardIds: v.optional(v.array(v.id("teams"))),
    attributes: v.optional(v.array(v.string())),
    // NEO-25: structured per-card fields now editable from the card detail
    // panel. All are full-replacement (omit to leave untouched). `isRookie`/
    // `isRelic` are derived by the caller from `attributes` (RC / RELIC) so
    // the boolean columns can't drift from the token array. Clearing a string
    // field is done by sending "" (sending undefined leaves it untouched).
    printRun: v.optional(v.number()),
    autographType: v.optional(v.string()),
    cardVariation: v.optional(v.string()),
    isRookie: v.optional(v.boolean()),
    isRelic: v.optional(v.boolean()),
    playerIds: v.optional(v.array(v.id("players"))),
    listingTitle: v.optional(v.string()),
    listingDescription: v.optional(v.string()),
    // NEO-24: full-replacement features patch. Callers pass the entire
    // desired map (or omit). Per-key edits should go through
    // `setCardFeature` so the propagation-engine semantics around the
    // "matches old set-level value" rule stay consistent.
    features: featuresValidator,
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const { id, ...updates } = args;
    const filtered: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        filtered[key] = value;
      }
    }
    if (Object.keys(filtered).length > 0) {
      await ctx.db.patch(id, { ...filtered, lastUpdated: Date.now() });
    }
    return null;
  },
});

export const deleteCard = mutation({
  args: { id: v.id("cardChecklist") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await ctx.db.delete(args.id);
    return null;
  },
});

// ===========================================================================
// NEO-24: Feature propagation engine
// ===========================================================================
//
// Two mutations work together to maintain the marketplace-agnostic feature
// map:
//
//   - setSelectorOptionFeature(selectorOptionId, key, value)
//       Patches a single key on a selectorOptions row, then walks every
//       descendant cardChecklist row. Cards with `features[key]` undefined
//       OR equal to the previous set-level value get the new value written
//       through. Cards that have already overridden the key are left
//       untouched and counted as `skippedAsOverridden`. Counts are returned
//       so the UI can confirm propagation scope before showing a toast.
//       (Formerly there was a separate `setSetMetadata` mutation for
//       releaseDate/totalCardCount/block, editable ONLY at the setName
//       level. Folded into this same feature map/mutation so those fields
//       can independently override at every set-side level too — e.g. a
//       parallel released later than its base set with its own release
//       date.)
//
//   - setCardFeature(cardChecklistId, key, value)
//       Plain per-card patch — no propagation. Use this for explicit
//       per-card overrides.
//
// Inheritance at card-creation time happens in `commitCardChecklist`
// (further down this file): the new card's `features` is the top-down
// merge of every ancestor's `features` map.
//
// Why descend through `children`?
//   The hierarchy is sport → year → manufacturer → setName → variantType →
//   insert → parallel. Cards live under the leaf row. We walk the children
//   array on each selectorOption (the same array reconciliation maintains)
//   to find every leaf, then query cardChecklist by selectorOption. This
//   keeps the descent additive — no index changes required — and matches
//   the existing pattern from `applyParallelGroupings` / reconciliation
//   code.

/**
 * Walks the children pointer-graph rooted at `rootId` and returns every
 * descendant selectorOption id (NOT including the root). Used by the
 * propagation engine to find every leaf whose cardChecklist rows need to
 * be considered for write-through.
 *
 * Bounded by Convex's 4096-read limit — each node is one ctx.db.get. Real
 * trees max out around (sport=1) * (year≈30) * (manufacturer≈10) *
 * (setName≈5) * (variantType≈3) * (insert≈20) * (parallel≈5) ≈ a few
 * thousand nodes worst case, but most propagation targets a single set or
 * variantType (≪ 100 descendants).
 */
async function collectDescendantIds(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<unknown> } },
  rootId: Id<"selectorOptions">,
): Promise<Array<Id<"selectorOptions">>> {
  const out: Array<Id<"selectorOptions">> = [];
  const stack: Array<Id<"selectorOptions">> = [rootId];
  const seen = new Set<string>([rootId]);
  while (stack.length > 0) {
    const id = stack.pop()!;
    const row = (await ctx.db.get(id)) as
      | { children?: Array<Id<"selectorOptions">> }
      | null;
    if (!row?.children) continue;
    for (const childId of row.children) {
      const key = childId as unknown as string;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(childId);
      stack.push(childId);
    }
  }
  return out;
}


/**
 * NEO-38: core materialization routine shared by the public
 * `setSelectorOptionFeature` mutation AND the in-mutation heuristic seed
 * inside `commitCardChecklist`. Convex mutations can't call other mutations
 * (no ctx.runMutation in a mutation), so the propagation logic lives here as a
 * plain helper that takes a mutation `ctx`.
 *
 * Materialized inheritance: patches `key=value` onto the target node, then
 * cascades to descendant NODES and to cardChecklist rows under the root + every
 * descendant node. A node/card is overwritten when its current value is
 * undefined OR equals the target node's PREVIOUS value (`oldValue`); any other
 * value is treated as an operator/card-observed override and left untouched
 * (counted as `skippedAsOverridden`). Re-applying the same value is idempotent.
 */
export async function materializeSelectorOptionFeature(
  ctx: { db: { get: any; patch: any; query: any } },
  selectorOptionId: Id<"selectorOptions">,
  key: string,
  value: string,
): Promise<{
  propagatedToCardCount: number;
  propagatedToNodeCount: number;
  skippedAsOverridden: number;
}> {
  validateFeatureValue(key, value);

  const row = await ctx.db.get(selectorOptionId);
  if (!row) {
    throw new Error(`selectorOption ${selectorOptionId} not found`);
  }

  const oldValue: string | undefined = row.features?.[key]; // may be undefined
  const newFeatures: Record<string, string> = {
    ...(row.features ?? {}),
    [key]: value,
  };
  await ctx.db.patch(selectorOptionId, {
    features: newFeatures,
    lastUpdated: Date.now(),
  });

  // Collect every descendant selectorOption (NOT including the root, which we
  // just patched). We materialize the value onto descendant nodes AND the
  // cardChecklist rows that hang off any node in the subtree.
  const descendantIds: Array<Id<"selectorOptions">> =
    await collectDescendantIds(ctx, selectorOptionId);

  let propagatedToCardCount = 0;
  let propagatedToNodeCount = 0;
  let skippedAsOverridden = 0;

  // 1. Materialize onto descendant NODES. Same overwrite rule as cards:
  //    undefined or === oldValue → overwrite; any other value is an override.
  for (const optId of descendantIds) {
    const node = await ctx.db.get(optId);
    if (!node) continue;
    const nodeValue = node.features?.[key];
    if (nodeValue === value) {
      // Already up-to-date; idempotent no-op.
      continue;
    }
    if (nodeValue === undefined || nodeValue === oldValue) {
      await ctx.db.patch(optId, {
        features: { ...(node.features ?? {}), [key]: value },
        lastUpdated: Date.now(),
      });
      propagatedToNodeCount += 1;
    } else {
      // Descendant node carries its own override — leave it (and, by the
      // materialized model, its own descendants are governed by ITS value,
      // so they're correctly skipped here too since they'd also differ).
      skippedAsOverridden += 1;
    }
  }

  // 2. Materialize onto cardChecklist rows under the root + every descendant
  //    node. Cards live under any node in the subtree (variant / insert /
  //    parallel), so we don't restrict to leaves.
  const cardNodeIds: Array<Id<"selectorOptions">> = [
    selectorOptionId,
    ...descendantIds,
  ];
  for (const optId of cardNodeIds) {
    const cards = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q: any) =>
        q.eq("selectorOptionId", optId),
      )
      .collect();
    for (const card of cards) {
      const cardValue = card.features?.[key];
      if (cardValue === value) {
        // Already up-to-date; no-op, not counted. Keeps re-setting the
        // same value idempotent (zero propagated, zero overridden).
        continue;
      }
      if (cardValue === undefined || cardValue === oldValue) {
        await ctx.db.patch(card._id, {
          features: { ...(card.features ?? {}), [key]: value },
          lastUpdated: Date.now(),
        });
        propagatedToCardCount += 1;
      } else {
        // Explicit per-card override (differs from both undefined and
        // the previous set-level value) — leave it.
        skippedAsOverridden += 1;
      }
    }
  }

  return {
    propagatedToCardCount,
    propagatedToNodeCount,
    skippedAsOverridden,
  };
}

// NEO-71-74: single-row patch, matching setCardFeature's shape exactly — an
// edit updates only the row being edited, never children or cards. Every
// row's `features` is already a complete, self-contained snapshot from its
// own creation (copy-down); descendants/cards created AFTER this edit pick
// it up naturally via that same copy-down, but rows that already existed
// before the edit keep whatever they were seeded with.
export const setSelectorOptionFeature = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    key: v.string(),
    value: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    validateFeatureValue(args.key, args.value);
    const row = await ctx.db.get(args.selectorOptionId);
    if (!row) {
      throw new Error(`selectorOption ${args.selectorOptionId} not found`);
    }
    await ctx.db.patch(args.selectorOptionId, {
      features: { ...(row.features ?? {}), [args.key]: args.value },
      lastUpdated: Date.now(),
    });
    return null;
  },
});

export const setCardFeature = mutation({
  args: {
    cardChecklistId: v.id("cardChecklist"),
    key: v.string(),
    value: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    validateFeatureValue(args.key, args.value);
    const card = await ctx.db.get(args.cardChecklistId);
    if (!card) {
      throw new Error(`cardChecklist ${args.cardChecklistId} not found`);
    }
    const features = { ...(card.features ?? {}), [args.key]: args.value };

    // Autographed flipping from blank/None to a real format: default Signed
    // By to the player(s) already attached to this card. Multiple players
    // (e.g. a dual/triple relic-auto) are all included, comma-separated.
    // An operator can still edit Signed By afterward — this only seeds it.
    if (args.key === "autographed") {
      const wasBlank = (card.features?.autographed ?? "None") === "None";
      const isNowSet = args.value !== "None";
      if (wasBlank && isNowSet && card.playerIds && card.playerIds.length > 0) {
        const players = await Promise.all(
          card.playerIds.map((id) => ctx.db.get(id)),
        );
        const names = players
          .filter((p): p is NonNullable<typeof p> => p !== null)
          .map((p) => p.name);
        if (names.length > 0) {
          features.signedBy = names.join(", ");
        }
      }
    }

    await ctx.db.patch(args.cardChecklistId, {
      features,
      lastUpdated: Date.now(),
    });
    return null;
  },
});

// Returns all `level=insert` rows under a variantType, each with its own
// `level=parallel` children inlined. Powers ParallelGroupingModal — one
// round trip pulls the full tree for the modal to render and diff against.
export const getInsertTreeByVariantType = query({
  args: { variantTypeId: v.id("selectorOptions") },
  returns: v.array(
    v.object({
      insert: v.object({
        _id: v.id("selectorOptions"),
        _creationTime: v.number(),
        level: levelValidator,
        value: v.string(),
        platformData: v.object({
          bsc: v.optional(v.union(v.string(), v.array(v.string()))),
          sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
          sportlotsDisplay: v.optional(v.string()),
        }),
        parentId: v.optional(v.id("selectorOptions")),
        children: v.optional(v.array(v.id("selectorOptions"))),
        isCustom: v.optional(v.boolean()),
        createdByUserId: v.optional(v.string()),
        metadata: metadataValidator,
          features: featuresValidator,
        lastUpdated: v.number(),
      }),
      parallels: v.array(
        v.object({
          _id: v.id("selectorOptions"),
          _creationTime: v.number(),
          level: levelValidator,
          value: v.string(),
          platformData: v.object({
            bsc: v.optional(v.union(v.string(), v.array(v.string()))),
            sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
            sportlotsDisplay: v.optional(v.string()),
          }),
          parentId: v.optional(v.id("selectorOptions")),
          children: v.optional(v.array(v.id("selectorOptions"))),
          isCustom: v.optional(v.boolean()),
          createdByUserId: v.optional(v.string()),
          metadata: metadataValidator,
              features: featuresValidator,
          lastUpdated: v.number(),
        }),
      ),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const inserts = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", "insert").eq("parentId", args.variantTypeId),
      )
      .collect();

    const tree: Array<{
      insert: (typeof inserts)[number];
      parallels: (typeof inserts)[number][];
    }> = [];
    for (const ins of inserts) {
      const parallels = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "parallel").eq("parentId", ins._id),
        )
        .collect();
      tree.push({ insert: ins, parallels });
    }
    return tree;
  },
});

// Atomic batch re-parenting for inserts/parallels under a single variantType.
//
// `promotions`: each entry moves an insert row down to be a parallel of a
// target insert under the same variantType. Source must be level=insert with
// no existing parallel children (otherwise we'd orphan a level — parallels
// are always terminal).
//
// `demotions`: each entry moves a parallel back up to be a top-level insert
// under the variantType.
//
// All assertions run before any patches so a partial failure rejects cleanly.
// Children arrays on parents are kept consistent.
export const applyParallelGroupings = mutation({
  args: {
    variantTypeId: v.id("selectorOptions"),
    promotions: v.array(
      v.object({
        insertId: v.id("selectorOptions"),
        targetInsertId: v.id("selectorOptions"),
      }),
    ),
    demotions: v.array(
      v.object({
        parallelId: v.id("selectorOptions"),
      }),
    ),
    // A parallel that's already under one insert moving to a different
    // insert's parallel list. Single patch (parentId), level stays.
    reparentings: v.optional(
      v.array(
        v.object({
          parallelId: v.id("selectorOptions"),
          newInsertId: v.id("selectorOptions"),
        }),
      ),
    ),
  },
  returns: v.object({
    success: v.boolean(),
    promoted: v.number(),
    demoted: v.number(),
    reparented: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const variantType = await ctx.db.get(args.variantTypeId);
    if (!variantType) {
      throw new Error("Variant type not found");
    }
    if (variantType.level !== "variantType") {
      throw new Error(
        `applyParallelGroupings target must be a variantType row; got ${variantType.level}`,
      );
    }

    // Track in-memory children sets keyed by row id so multiple promotions/
    // demotions touching the same parent compose correctly without re-reading.
    const childrenMap = new Map<Id<"selectorOptions">, Set<Id<"selectorOptions">>>();
    const getChildren = async (
      id: Id<"selectorOptions">,
    ): Promise<Set<Id<"selectorOptions">>> => {
      let set = childrenMap.get(id);
      if (!set) {
        const row = await ctx.db.get(id);
        set = new Set(row?.children ?? []);
        childrenMap.set(id, set);
      }
      return set;
    };

    const now = Date.now();

    // ---- Validate everything first ----
    const promotionTargets: Array<{
      sourceId: Id<"selectorOptions">;
      targetId: Id<"selectorOptions">;
    }> = [];
    for (const p of args.promotions) {
      const source = await ctx.db.get(p.insertId);
      if (!source) throw new Error(`Source insert ${p.insertId} not found`);
      if (source.level !== "insert") {
        throw new Error(
          `Source ${p.insertId} is not an insert (level=${source.level})`,
        );
      }
      if (source.parentId !== args.variantTypeId) {
        throw new Error(
          `Source ${p.insertId} is not under variantType ${args.variantTypeId}`,
        );
      }
      const target = await ctx.db.get(p.targetInsertId);
      if (!target) throw new Error(`Target insert ${p.targetInsertId} not found`);
      if (target.level !== "insert") {
        throw new Error(
          `Target ${p.targetInsertId} is not an insert (level=${target.level})`,
        );
      }
      if (target.parentId !== args.variantTypeId) {
        throw new Error(
          `Target ${p.targetInsertId} is not under variantType ${args.variantTypeId}`,
        );
      }
      // Defensive: refuse to promote an insert that already has parallels
      // beneath it (would create parallels-of-parallels).
      const existingParallels = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "parallel").eq("parentId", p.insertId),
        )
        .first();
      if (existingParallels) {
        throw new Error(
          `Cannot promote insert "${source.value}" to parallel — it already has parallels beneath it.`,
        );
      }
      promotionTargets.push({ sourceId: p.insertId, targetId: p.targetInsertId });
    }

    const demotionTargets: Array<{
      parallelId: Id<"selectorOptions">;
      oldParentId: Id<"selectorOptions">;
    }> = [];
    for (const d of args.demotions) {
      const row = await ctx.db.get(d.parallelId);
      if (!row) throw new Error(`Parallel ${d.parallelId} not found`);
      if (row.level !== "parallel") {
        throw new Error(
          `Source ${d.parallelId} is not a parallel (level=${row.level})`,
        );
      }
      if (!row.parentId) {
        throw new Error(`Parallel ${d.parallelId} has no parent`);
      }
      demotionTargets.push({ parallelId: d.parallelId, oldParentId: row.parentId });
    }

    const reparentingTargets: Array<{
      parallelId: Id<"selectorOptions">;
      oldParentId: Id<"selectorOptions">;
      newParentId: Id<"selectorOptions">;
    }> = [];
    for (const r of args.reparentings ?? []) {
      const row = await ctx.db.get(r.parallelId);
      if (!row) throw new Error(`Parallel ${r.parallelId} not found`);
      if (row.level !== "parallel") {
        throw new Error(
          `Reparent source ${r.parallelId} is not a parallel (level=${row.level})`,
        );
      }
      if (!row.parentId) {
        throw new Error(`Parallel ${r.parallelId} has no parent`);
      }
      if (row.parentId === r.newInsertId) {
        // No-op: same parent. Skip silently.
        continue;
      }
      const target = await ctx.db.get(r.newInsertId);
      if (!target) throw new Error(`New insert ${r.newInsertId} not found`);
      if (target.level !== "insert") {
        throw new Error(
          `Reparent target ${r.newInsertId} is not an insert (level=${target.level})`,
        );
      }
      if (target.parentId !== args.variantTypeId) {
        throw new Error(
          `Reparent target ${r.newInsertId} is not under variantType ${args.variantTypeId}`,
        );
      }
      reparentingTargets.push({
        parallelId: r.parallelId,
        oldParentId: row.parentId,
        newParentId: r.newInsertId,
      });
    }

    // ---- Apply promotions ----
    const variantTypeChildren = await getChildren(args.variantTypeId);
    for (const { sourceId, targetId } of promotionTargets) {
      await ctx.db.patch(sourceId, {
        level: "parallel",
        parentId: targetId,
        lastUpdated: now,
      });
      variantTypeChildren.delete(sourceId);
      const targetChildren = await getChildren(targetId);
      targetChildren.add(sourceId);
    }

    // ---- Apply demotions ----
    for (const { parallelId, oldParentId } of demotionTargets) {
      await ctx.db.patch(parallelId, {
        level: "insert",
        parentId: args.variantTypeId,
        lastUpdated: now,
      });
      const oldParentChildren = await getChildren(oldParentId);
      oldParentChildren.delete(parallelId);
      variantTypeChildren.add(parallelId);
    }

    // ---- Apply reparentings ----
    for (const { parallelId, oldParentId, newParentId } of reparentingTargets) {
      await ctx.db.patch(parallelId, {
        parentId: newParentId,
        lastUpdated: now,
      });
      const oldChildren = await getChildren(oldParentId);
      oldChildren.delete(parallelId);
      const newChildren = await getChildren(newParentId);
      newChildren.add(parallelId);
    }

    // ---- Flush children-array updates ----
    for (const [id, set] of childrenMap) {
      await ctx.db.patch(id, { children: Array.from(set), lastUpdated: now });
    }

    return {
      success: true,
      promoted: promotionTargets.length,
      demoted: demotionTargets.length,
      reparented: reparentingTargets.length,
    };
  },
});

// Patches platformData (and optional metadata) onto a Base variantType row.
// Base is the terminal node in the cascade — its platform mapping lives on
// the variantType row itself, not on a child insert. Asserts the target is
// actually variantType=Base to prevent misuse on Insert/Parallel rows
// (which go through `storeReconciledOptions`).
export const setVariantTypePlatformData = mutation({
  args: {
    variantTypeId: v.id("selectorOptions"),
    platformData: v.object({
      bsc: v.optional(v.union(v.string(), v.array(v.string()))),
      sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
      sportlotsDisplay: v.optional(v.string()),
    }),
    metadata: v.optional(v.object({
      cardNumberPrefix: v.optional(v.string()),
      isInsert: v.optional(v.boolean()),
      isParallel: v.optional(v.boolean()),
    })),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(args.variantTypeId);
    if (!row) {
      throw new Error("Variant type row not found");
    }
    if (row.level !== "variantType") {
      throw new Error(
        `setVariantTypePlatformData only operates on variantType rows; got ${row.level}`,
      );
    }
    if (row.value.toLowerCase().trim() !== "base") {
      throw new Error(
        `setVariantTypePlatformData only operates on Base variantTypes; got "${row.value}"`,
      );
    }
    const merged: Record<string, unknown> = {
      platformData: { ...row.platformData, ...args.platformData },
      lastUpdated: Date.now(),
    };
    if (args.metadata) {
      merged.metadata = { ...(row.metadata || {}), ...args.metadata };
    }
    await ctx.db.patch(args.variantTypeId, merged);
    return { success: true, message: "Stored Base mapping" };
  },
});

export const updateSelectorOptionMetadata = mutation({
  args: {
    id: v.id("selectorOptions"),
    metadata: v.object({
      cardNumberPrefix: v.optional(v.string()),
      isInsert: v.optional(v.boolean()),
      isParallel: v.optional(v.boolean()),
    }),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const existing = await ctx.db.get(args.id);
    if (!existing) {
      throw new Error("Selector option not found");
    }
    await ctx.db.patch(args.id, {
      metadata: { ...(existing.metadata || {}), ...args.metadata },
      lastUpdated: Date.now(),
    });
    return null;
  },
});

// ===== ADMIN UTILITIES =====

/**
 * Full reset of Set Builder data. Deletes every row in `selectorOptions`
 * and `cardChecklist`. Intended for dev cleanup between test runs.
 *
 * Two layers of safety (enforced in the internal mutations below):
 * 1. requireAdmin — only the admin role can call this from a signed-in session.
 * 2. ALLOW_RESET_SET_BUILDER_DATA env var — must be set to "true" on the
 *    Convex deployment. Set on dev + preview + integration-test deployments
 *    (where E2E tests reset state between runs); unset on production.
 *    Without this gate, the admin user could accidentally wipe production
 *    data by clicking "Reset Set Builder Data" while pointed at prod.
 *
 * Implementation: this is an action that loops a paginated internal
 * mutation. A single mutation has a per-execution read limit of 4096
 * rows; on dev deployments where selectorOptions has accumulated many
 * thousands of rows from prior test runs, a single-pass `.collect()`
 * was throwing "Too many reads in a single function execution".
 */
const RESET_BATCH_SIZE = 500;

export const resetSetBuilderData = action({
  args: {},
  returns: v.object({
    selectorOptionsDeleted: v.number(),
    cardChecklistDeleted: v.number(),
    playersDeleted: v.number(),
    teamsDeleted: v.number(),
  }),
  handler: async (
    ctx,
  ): Promise<{
    selectorOptionsDeleted: number;
    cardChecklistDeleted: number;
    playersDeleted: number;
    teamsDeleted: number;
  }> => {
    // Auth and env-var gate are enforced in the internal mutations called
    // below — keeping the destructive guard as close to the actual delete
    // as possible. If either check fails on the first batch, the loop
    // exits before any rows are deleted.

    let selectorOptionsDeleted = 0;
    while (true) {
      const result = await ctx.runMutation(
        internal.selectorOptions.resetSelectorOptionsBatch,
        {},
      );
      selectorOptionsDeleted += result.deleted;
      if (!result.hasMore) break;
    }

    let cardChecklistDeleted = 0;
    while (true) {
      const result = await ctx.runMutation(
        internal.selectorOptions.resetCardChecklistBatch,
        {},
      );
      cardChecklistDeleted += result.deleted;
      if (!result.hasMore) break;
    }

    // Players + teams are populated alongside cardChecklist by the
    // commitCardChecklist flow. Wipe them too so subsequent dev/test
    // runs see a clean "unknown entities" state and the
    // UnknownEntitiesDialog re-opens for confirmation. Without this,
    // E2E flows that rely on the dialog appearing fail because the
    // entities from prior runs are already known.
    let playersDeleted = 0;
    while (true) {
      const result = await ctx.runMutation(
        internal.selectorOptions.resetPlayersBatch,
        {},
      );
      playersDeleted += result.deleted;
      if (!result.hasMore) break;
    }

    let teamsDeleted = 0;
    while (true) {
      const result = await ctx.runMutation(
        internal.selectorOptions.resetTeamsBatch,
        {},
      );
      teamsDeleted += result.deleted;
      if (!result.hasMore) break;
    }

    return { selectorOptionsDeleted, cardChecklistDeleted, playersDeleted, teamsDeleted };
  },
});

/**
 * Internal: delete up to RESET_BATCH_SIZE rows from selectorOptions.
 * Used by resetSetBuilderData (action) in a loop until no rows remain.
 */
export const resetSelectorOptionsBatch = internalMutation({
  args: {},
  returns: v.object({
    deleted: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    if (process.env.ALLOW_RESET_SET_BUILDER_DATA !== "true") {
      throw new Error(
        "Reset Set Builder Data is not enabled in this environment. " +
          "Set ALLOW_RESET_SET_BUILDER_DATA=true on the Convex deployment to enable.",
      );
    }
    const rows = await ctx.db.query("selectorOptions").take(RESET_BATCH_SIZE);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, hasMore: rows.length === RESET_BATCH_SIZE };
  },
});

/**
 * Internal: delete up to RESET_BATCH_SIZE rows from cardChecklist.
 * Used by resetSetBuilderData (action) in a loop until no rows remain.
 */
export const resetCardChecklistBatch = internalMutation({
  args: {},
  returns: v.object({
    deleted: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    if (process.env.ALLOW_RESET_SET_BUILDER_DATA !== "true") {
      throw new Error(
        "Reset Set Builder Data is not enabled in this environment. " +
          "Set ALLOW_RESET_SET_BUILDER_DATA=true on the Convex deployment to enable.",
      );
    }
    const rows = await ctx.db.query("cardChecklist").take(RESET_BATCH_SIZE);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, hasMore: rows.length === RESET_BATCH_SIZE };
  },
});

/**
 * Internal: delete up to RESET_BATCH_SIZE rows from players.
 * Used by resetSetBuilderData (action) in a loop until no rows remain.
 */
export const resetPlayersBatch = internalMutation({
  args: {},
  returns: v.object({
    deleted: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    if (process.env.ALLOW_RESET_SET_BUILDER_DATA !== "true") {
      throw new Error(
        "Reset Set Builder Data is not enabled in this environment. " +
          "Set ALLOW_RESET_SET_BUILDER_DATA=true on the Convex deployment to enable.",
      );
    }
    const rows = await ctx.db.query("players").take(RESET_BATCH_SIZE);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, hasMore: rows.length === RESET_BATCH_SIZE };
  },
});

/**
 * Internal: delete up to RESET_BATCH_SIZE rows from teams.
 * Used by resetSetBuilderData (action) in a loop until no rows remain.
 */
export const resetTeamsBatch = internalMutation({
  args: {},
  returns: v.object({
    deleted: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    if (process.env.ALLOW_RESET_SET_BUILDER_DATA !== "true") {
      throw new Error(
        "Reset Set Builder Data is not enabled in this environment. " +
          "Set ALLOW_RESET_SET_BUILDER_DATA=true on the Convex deployment to enable.",
      );
    }
    const rows = await ctx.db.query("teams").take(RESET_BATCH_SIZE);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, hasMore: rows.length === RESET_BATCH_SIZE };
  },
});

/**
 * One-time cleanup: deletes legacy child rows under Base variantTypes.
 *
 * Before Base became a terminal node, the sync flow created a single
 * `level=insert` row under each Base variantType to hold the SL/BSC
 * platform mapping and any synced cardChecklist. This mutation removes
 * those orphan rows (and any parallels under them, plus their checklist
 * entries) so the Base variantType row itself can carry the platform
 * mapping. Custom cards/inserts under those rows are dropped — by user
 * direction.
 *
 * Re-runnable: idempotent. After the first run, no Base variantTypes will
 * have children and subsequent runs are no-ops.
 */
export const wipeLegacyBaseChildren = mutation({
  args: {},
  returns: v.object({
    baseVariantTypesScanned: v.number(),
    insertsDeleted: v.number(),
    parallelsDeleted: v.number(),
    cardChecklistRowsDeleted: v.number(),
  }),
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const baseVariantTypes = (
      await ctx.db.query("selectorOptions").withIndex("by_level").collect()
    ).filter(
      (row) =>
        row.level === "variantType" &&
        row.value.toLowerCase().trim() === "base",
    );

    let insertsDeleted = 0;
    let parallelsDeleted = 0;
    let cardChecklistRowsDeleted = 0;

    for (const baseVT of baseVariantTypes) {
      const inserts = await ctx.db
        .query("selectorOptions")
        .withIndex("by_level_and_parent", (q) =>
          q.eq("level", "insert").eq("parentId", baseVT._id),
        )
        .collect();

      for (const ins of inserts) {
        const parallels = await ctx.db
          .query("selectorOptions")
          .withIndex("by_level_and_parent", (q) =>
            q.eq("level", "parallel").eq("parentId", ins._id),
          )
          .collect();

        for (const par of parallels) {
          const parCards = await ctx.db
            .query("cardChecklist")
            .withIndex("by_selector_option", (q) =>
              q.eq("selectorOptionId", par._id),
            )
            .collect();
          for (const c of parCards) {
            await ctx.db.delete(c._id);
            cardChecklistRowsDeleted += 1;
          }
          await ctx.db.delete(par._id);
          parallelsDeleted += 1;
        }

        const insCards = await ctx.db
          .query("cardChecklist")
          .withIndex("by_selector_option", (q) =>
            q.eq("selectorOptionId", ins._id),
          )
          .collect();
        for (const c of insCards) {
          await ctx.db.delete(c._id);
          cardChecklistRowsDeleted += 1;
        }
        await ctx.db.delete(ins._id);
        insertsDeleted += 1;
      }

      await ctx.db.patch(baseVT._id, { children: [], lastUpdated: Date.now() });
    }

    return {
      baseVariantTypesScanned: baseVariantTypes.length,
      insertsDeleted,
      parallelsDeleted,
      cardChecklistRowsDeleted,
    };
  },
});

// ===== ACTIONS (Orchestrators) =====

// Per-child hard deadlines for the aggregator. The child adapters bound their
// own marketplace fetches (SL: 3s × 3; BSC: 10s × 3), but if a child hangs
// *upstream* of the fetch — e.g. a stuck cold-login in getSiteToken — its
// promise can never settle, and a bare Promise.allSettled would wait forever,
// so fetchAggregatedOptions would never reach recordAdapterCall and the FE
// column would spin "Syncing…" with NOTHING logged. These deadlines guarantee
// each branch resolves; whichever blows its budget is attributed via
// timed_out_platform on the aggregator's adapter_sync_call. Budgets = the
// child's own retry ceiling + margin (SL ≈ 9s, BSC ≈ 30s).
const SL_CHILD_DEADLINE_MS = 12_000;
const BSC_CHILD_DEADLINE_MS = 35_000;

type ChildOutcome<T> =
  | { kind: "settled"; value: T }
  | { kind: "rejected"; reason: unknown }
  | { kind: "timeout"; ms: number };

// Race a child action against a hard deadline. NEVER rejects — a late
// rejection from the orphaned child (after the deadline already won) is
// swallowed so it can't surface as an unhandledRejection.
function withChildDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<ChildOutcome<T>> {
  return Promise.race<ChildOutcome<T>>([
    promise.then(
      (value): ChildOutcome<T> => ({ kind: "settled", value }),
      (reason): ChildOutcome<T> => ({ kind: "rejected", reason }),
    ),
    new Promise<ChildOutcome<T>>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout", ms }), ms),
    ),
  ]);
}

// ─── SetSelector sync redesign (NEO-47) ──────────────────────────────────────
// One marketplace-agnostic door for the FE: it reads options via
// getSelectorOptions and, when a column opens empty, calls ensureSelectorOptions.
// The backend owns the whole "should I sync, and how" decision (already
// populated? custom subtree? which level-strategy?) and reports progress via the
// selectorSyncStatus table, which the FE reads reactively to drive loading/error
// — replacing EntityColumn's fragile sync state-machine + onDone handoff.
// Phase 1 routes the aggregator levels (sport/year/manufacturer/variantType);
// setName + insert/parallel keep their existing path until Phases 2-3.

/** Write/clear the transient per-(level,parentId) sync status. status omitted = clear (delete). */
export const setSelectorSyncStatus = internalMutation({
  args: {
    level: levelValidator,
    parentId: v.optional(v.id("selectorOptions")),
    status: v.optional(v.union(v.literal("syncing"), v.literal("error"))),
    message: v.optional(v.string()),
    requestId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("selectorSyncStatus")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", args.level).eq("parentId", args.parentId),
      )
      .first();
    if (!args.status) {
      if (existing) await ctx.db.delete(existing._id);
      return null;
    }
    const fields = {
      status: args.status,
      message: args.message,
      requestId: args.requestId,
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.patch(existing._id, fields);
    else
      await ctx.db.insert("selectorSyncStatus", {
        level: args.level,
        parentId: args.parentId,
        ...fields,
      });
    return null;
  },
});

/** Reactive sync status for one column (FE-facing). null = idle (not syncing, no error). */
export const getSelectorSyncStatus = query({
  args: {
    level: levelValidator,
    parentId: v.optional(v.id("selectorOptions")),
  },
  returns: v.union(
    v.object({
      status: v.union(v.literal("syncing"), v.literal("error")),
      message: v.optional(v.string()),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    // Admin-gated like every other query in this file — the whole set-builder
    // taxonomy is admin-managed (getSelectorOptions/getAncestorChain gate too),
    // and `message` may carry backend sync detail that must not reach non-admins.
    await requireAdmin(ctx);
    const row = await ctx.db
      .query("selectorSyncStatus")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", args.level).eq("parentId", args.parentId),
      )
      .first();
    return row ? { status: row.status, message: row.message } : null;
  },
});

// User-safe error surfaced via the reactive selectorSyncStatus.message — the
// raw sync/exception detail goes to console.error only, never into reactive
// state (security audit, NEO-47).
const SYNC_ERROR_MESSAGE = "Couldn't sync options — please try again.";

/**
 * The single FE entry point to populate a column (NEO-47). An ACTION, not a
 * mutation+scheduler: a scheduled function runs with NO auth (system identity),
 * so fetchAggregatedOptions' requireAdmin threw "Not authenticated". ctx.runAction
 * from an authenticated action PROPAGATES the caller's admin identity, so we run
 * the sync inline instead. Backend owns every decision: already-populated → no-op;
 * custom subtree → no-op (the uniform skip the legacy paths applied
 * inconsistently); else mark "syncing", run the level's sync, clear/error the
 * status. The FE fires this (fire-and-forget) and watches selectorSyncStatus
 * reactively, so the long fetch never blocks the UI.
 */
export const ensureSelectorOptions = action({
  args: {
    level: levelValidator,
    parentId: v.optional(v.id("selectorOptions")),
    force: v.optional(v.boolean()),
  },
  returns: v.object({ ran: v.boolean(), reason: v.string() }),
  handler: async (
    ctx,
    args,
  ): Promise<{ ran: boolean; reason: string }> => {
    await requireAdmin(ctx);
    const { level, parentId, force } = args;

    // Already populated? (skip unless a forced refresh)
    if (!force) {
      const existing = await ctx.runQuery(
        api.selectorOptions.getSelectorOptions,
        { level, parentId },
      );
      if (existing.length > 0)
        return { ran: false, reason: "already_populated" };
    }

    // Derive the chain once: uniform custom-subtree skip + parentFilters + the
    // year id (setName syncs at the year level — BSC has no manufacturer facet).
    const parentFilters: {
      sport?: string;
      year?: string;
      manufacturer?: string;
      setName?: string;
    } = {};
    let yearId: Id<"selectorOptions"> | undefined;
    if (parentId) {
      const chain = await ctx.runQuery(api.selectorOptions.getAncestorChain, {
        id: parentId,
      });
      // A custom ancestor has no marketplace presence → no level below it syncs.
      // (The legacy fetchRawOptions lacked this skip entirely.)
      if (isCustomSubtree(chain)) {
        await ctx.runMutation(internal.selectorOptions.setSelectorSyncStatus, {
          level,
          parentId,
        });
        return { ran: false, reason: "custom_subtree" };
      }
      for (const a of chain) {
        if (a.level === "year") yearId = a._id;
        if (
          a.level === "sport" ||
          a.level === "year" ||
          a.level === "manufacturer" ||
          a.level === "setName"
        ) {
          parentFilters[a.level] = a.value;
        }
      }
    }

    const requestId = newRequestId();
    await ctx.runMutation(internal.selectorOptions.setSelectorSyncStatus, {
      level,
      parentId,
      status: "syncing",
      requestId,
    });
    try {
      // Dispatch by level. setName syncs at the year level via
      // syncSetsAcrossManufacturers (BSC-only, manufacturer derived by
      // prefix-match — all that taxonomy-stitching stays inside that action,
      // below this door). Aggregator levels go through fetchAggregatedOptions.
      let res: { success: boolean; message: string };
      if (level === "setName") {
        if (!yearId) {
          await ctx.runMutation(
            internal.selectorOptions.setSelectorSyncStatus,
            {
              level,
              parentId,
              status: "error",
              message: "Cannot sync sets — no year ancestor.",
            },
          );
          return { ran: true, reason: "error" };
        }
        res = await ctx.runAction(
          api.selectorOptions.syncSetsAcrossManufacturers,
          { yearId },
        );
      } else {
        res = await ctx.runAction(
          api.selectorOptions.fetchAggregatedOptions,
          { level, parentId, parentFilters },
        );
      }
      if (!res.success) {
        // Raw sync detail → logs only; the persisted/reactive `message` stays
        // a user-safe string (security audit, NEO-47).
        console.error(
          `[ensureSelectorOptions] sync error (${level}):`,
          res.message,
        );
      }
      await ctx.runMutation(internal.selectorOptions.setSelectorSyncStatus, {
        level,
        parentId,
        // success OR empty → clear (idle); a real failure → recoverable error.
        ...(res.success
          ? {}
          : { status: "error" as const, message: SYNC_ERROR_MESSAGE }),
      });
      return { ran: true, reason: res.success ? "synced" : "error" };
    } catch (e) {
      // Raw exception detail → logs only; reactive `message` stays generic.
      console.error(
        `[ensureSelectorOptions] sync threw (${level}):`,
        e instanceof Error ? e.message : e,
      );
      await ctx.runMutation(internal.selectorOptions.setSelectorSyncStatus, {
        level,
        parentId,
        status: "error",
        message: SYNC_ERROR_MESSAGE,
      });
      return { ran: true, reason: "error" };
    }
  },
});

export const fetchAggregatedOptions = action({
  args: {
    level: levelValidator,
    parentId: v.optional(v.id("selectorOptions")),
    parentFilters: v.optional(
      v.object({
        sport: v.optional(v.string()),
        year: v.optional(v.string()),
        manufacturer: v.optional(v.string()),
        setName: v.optional(v.string()),
        variantType: v.optional(v.string()),
      }),
    ),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    optionsCount: v.number(),
  }),
  handler: async (ctx, args): Promise<{ success: boolean; message: string; optionsCount: number }> => {
    // Admin check is outside the try/catch so authorization errors surface
    // cleanly to the client instead of being rewritten as "Failed to fetch
    // options: Admin access required" by the generic catch below.
    await requireAdmin(ctx);

    // Correlation id for the adapter-perf dashboard. Generated here at the
    // outermost aggregator so child BSC/SL calls can tag their own
    // adapter_sync_call events with the same id, letting us reconstruct the
    // total/branch breakdown for a single user-facing request.
    const requestId = newRequestId();
    const aggregatorStart = Date.now();

    try {
      const { level, parentId, parentFilters } = args;

      console.log(
        `[fetchAggregatedOptions] Fetching ${level} options with filters:`,
        parentFilters,
        `requestId=${requestId}`,
      );

      // Build platform-specific filters from the ancestor chain so each
      // adapter receives its own slugs instead of display labels. Catch
      // missing slugs for BSC at the levels it actually filters on; SL
      // is intentionally not preconditioned because its adapter does its
      // own DB lookup / has no setName-level concept (see fetchCardChecklist).
      let slPlatformFilters: Record<string, string> | undefined;
      let bscPlatformFilters: Record<string, string[]> | undefined;
      const aggMissingBsc: string[] = [];

      if (parentId) {
        const chain = await ctx.runQuery(
          api.selectorOptions.getAncestorChain,
          { id: parentId },
        );

        // Custom-subtree gate (NEO-22). Skip both adapters when any ancestor
        // is user-created. "Once custom, always custom": a custom parent has
        // no marketplace presence, so NO level below it — manufacturer
        // included — can sync. (A previous exemption synced the static SL
        // manufacturer list even under a custom subtree; that violated the
        // rule and offered dead-end choices, since a custom sport has no
        // marketplace data below any manufacturer you'd pick.) The user adds
        // custom children and proceeds via the "+ Custom" button on each
        // column, all the way down to custom cards.
        if (isCustomSubtree(chain)) {
          console.log(
            `[fetchAggregatedOptions] custom subtree detected — skipping BSC/SL for level=${level}`,
          );
          await recordAdapterCall(ctx, {
            requestId,
            operation: "fetchAggregatedOptions",
            platform: "aggregator",
            level,
            parentSport: parentFilters?.sport,
            parentYear: parentFilters?.year,
            parentSetName: parentFilters?.setName,
            duration_ms: Date.now() - aggregatorStart,
            success: true,
            result_count: 0,
            error_class: "skipped_custom_subtree",
          });
          return {
            success: true,
            message:
              "Custom selector subtree — no marketplace options to aggregate.",
            optionsCount: 0,
          };
        }

        slPlatformFilters = {};
        bscPlatformFilters = {};

        const BSC_REQUIRED = new Set(["sport", "year", "setName"]);

        for (const ancestor of chain) {
          const lvl = ancestor.level;
          if (ancestor.platformData?.sportlots) {
            slPlatformFilters[lvl] = ancestor.platformData.sportlots;
          }
          if (ancestor.platformData?.bsc) {
            const bscVal = ancestor.platformData.bsc;
            bscPlatformFilters[lvl] = Array.isArray(bscVal) ? bscVal : [bscVal];
          } else if (BSC_REQUIRED.has(lvl)) {
            aggMissingBsc.push(`${lvl}=${ancestor.value}`);
          } else if (ancestor.value) {
            // Display-value fallback acceptable for non-required levels
            // only (manufacturer/variantType-style display passthroughs).
            bscPlatformFilters[lvl] = [ancestor.value.toLowerCase()];
          }
        }

        console.log(
          `[fetchAggregatedOptions] Resolved platform filters — SL:`,
          slPlatformFilters,
          `BSC:`,
          bscPlatformFilters,
        );
      }

      if (aggMissingBsc.length > 0) {
        const msg =
          `Cannot sync ${level} options — ancestor rows are missing BSC platform ` +
          `slugs on: ${aggMissingBsc.join(", ")}. Upstream selectorOptions ` +
          `hydration did not write the BSC slugs we need.`;
        console.error(`[fetchAggregatedOptions] precondition failed: ${msg}`);
        await recordAdapterCall(ctx, {
          requestId,
          operation: "fetchAggregatedOptions",
          platform: "aggregator",
          level,
          parentSport: parentFilters?.sport,
          parentYear: parentFilters?.year,
          parentSetName: parentFilters?.setName,
          duration_ms: Date.now() - aggregatorStart,
          success: false,
          result_count: 0,
          error_class: "precondition_missing_slug",
        });
        return {
          success: false,
          message: msg,
          optionsCount: 0,
        };
      }

      const allOptions: Array<{
        value: string;
        platformData: {
          bsc?: string | string[];
          sportlots?: string;
        };
      }> = [];

      const platformErrors: Record<string, string> = {};

      // Fetch SportLots and BSC in parallel. Sequential awaits gave a worst-
      // case latency of SL_TIMEOUT + BSC_TIMEOUT (~60s) and overran the
      // 10s UI budget on cold Cloud Run revisions of the browser service.
      // Promise.allSettled keeps one slow/failing platform from blocking
      // the other; per-platform errors are still captured into
      // platformErrors for the PostHog event + warning suffix.
      //
      // Each branch is wrapped in a Date.now() pair so we can attribute
      // total_ms to the SL branch vs the BSC branch on the adapter-perf
      // dashboard. Per-branch adapter_sync_call events are also fired by
      // the child actions themselves (see fetchBscSelectorOptions /
      // fetchSportLotsSelectorOptions) — this aggregator-level event is
      // what tells us how the two compose under Promise.allSettled.
      const slStart = Date.now();
      const bscStart = Date.now();
      // Each child is raced against a hard deadline (withChildDeadline) so a
      // hang upstream of the marketplace fetch (e.g. a stuck cold-login) can
      // never wedge the aggregator — Promise.all here always resolves within
      // max(SL, BSC) deadline, guaranteeing we reach recordAdapterCall.
      const [slOutcome, bscOutcome] = await Promise.all([
        withChildDeadline(
          ctx.runAction(api.adapters.sportlots.fetchSportLotsSelectorOptions, {
            level,
            parentFilters: parentFilters || {},
            ...(slPlatformFilters ? { platformFilters: slPlatformFilters } : {}),
            requestId,
          }),
          SL_CHILD_DEADLINE_MS,
        ),
        withChildDeadline(
          ctx.runAction(api.adapters.buysportscards.fetchBscSelectorOptions, {
            level,
            parentFilters: parentFilters || {},
            ...(bscPlatformFilters ? { platformFilters: bscPlatformFilters } : {}),
            requestId,
          }),
          BSC_CHILD_DEADLINE_MS,
        ),
      ]);
      const slDurationMs = Date.now() - slStart;
      const bscDurationMs = Date.now() - bscStart;

      let slSuccess = false;
      let bscSuccess = false;
      // When a child blows its aggregator deadline (rather than returning an
      // error), we tag the record with which platform stalled so PostHog can
      // distinguish "the marketplace answered with an error" from "the adapter
      // never came back at all". Set to "both" if both stalled.
      let timedOutPlatform: string | undefined;

      if (slOutcome.kind === "settled") {
        const sportlotsOptions = slOutcome.value;
        if (sportlotsOptions.success && sportlotsOptions.options) {
          slSuccess = true;
          allOptions.push(
            ...sportlotsOptions.options.map((o: { value: string; platformValue: string }) => ({
              value: o.value,
              platformData: { sportlots: o.platformValue },
            })),
          );
        } else if (!sportlotsOptions.success) {
          platformErrors.sportlots = sportlotsOptions.message || "Unknown error";
        }
      } else if (slOutcome.kind === "timeout") {
        timedOutPlatform = "sportlots";
        platformErrors.sportlots = `SportLots adapter exceeded ${slOutcome.ms / 1000}s deadline (no response — stalled before/within the marketplace fetch)`;
        console.error(`[fetchAggregatedOptions] SportLots child exceeded ${slOutcome.ms}ms deadline`);
      } else {
        const msg = slOutcome.reason instanceof Error ? slOutcome.reason.message : "Unknown error";
        platformErrors.sportlots = msg;
        console.error(`[fetchAggregatedOptions] SportLots error:`, slOutcome.reason);
      }

      if (bscOutcome.kind === "settled") {
        const bscOptions = bscOutcome.value;
        if (bscOptions.success && bscOptions.options) {
          bscSuccess = true;
          allOptions.push(
            ...bscOptions.options.map((o: { value: string; platformValue: string }) => ({
              value: o.value,
              platformData: { bsc: o.platformValue },
            })),
          );
        } else if (!bscOptions.success) {
          platformErrors.bsc = bscOptions.message || "Unknown error";
        }
      } else if (bscOutcome.kind === "timeout") {
        timedOutPlatform = timedOutPlatform ? "both" : "bsc";
        platformErrors.bsc = `BSC adapter exceeded ${bscOutcome.ms / 1000}s deadline (no response — stalled before/within the marketplace fetch)`;
        console.error(`[fetchAggregatedOptions] BSC child exceeded ${bscOutcome.ms}ms deadline`);
      } else {
        const msg = bscOutcome.reason instanceof Error ? bscOutcome.reason.message : "Unknown error";
        platformErrors.bsc = msg;
        console.error(`[fetchAggregatedOptions] BSC error:`, bscOutcome.reason);
      }

      // Debug: log platform errors and result counts
      if (Object.keys(platformErrors).length > 0) {
        console.error(`[fetchAggregatedOptions] Platform errors for ${level}:`, JSON.stringify(platformErrors));
      }

      // 3. Deduplicate by normalized value
      const valueMap = new Map<
        string,
        {
          value: string;
          platformData: { bsc?: string | string[]; sportlots?: string };
        }
      >();

      for (const option of allOptions) {
        const normalizedValue = option.value.toLowerCase().trim();
        const existing = valueMap.get(normalizedValue);

        if (existing) {
          // Merge platform data
          if (option.platformData.sportlots) {
            existing.platformData.sportlots = option.platformData.sportlots;
          }
          if (option.platformData.bsc) {
            existing.platformData.bsc = option.platformData.bsc;
          }
        } else {
          valueMap.set(normalizedValue, {
            value: option.value,
            platformData: { ...option.platformData },
          });
        }
      }

      const deduped = Array.from(valueMap.values());

      // 4. Log adapter errors to PostHog if any adapter failed
      if (Object.keys(platformErrors).length > 0) {
        let userId = "anonymous";
        try {
          userId = await getCurrentUserId(ctx) || "anonymous";
        } catch {
          // auth context may not be available
        }
        await ctx.runAction(internal.posthog.captureEvent, {
          distinctId: userId,
          event: "selector_sync_failed",
          properties: {
            level,
            platformErrors,
            parentFilters: parentFilters || {},
            totalOptionsReturned: deduped.length,
          },
        }).catch((err: unknown) => {
          console.error("[fetchAggregatedOptions] Failed to send PostHog event:", err);
        });
      }

      // 5. If no options were fetched from any platform, report failure
      if (deduped.length === 0) {
        await recordAdapterCall(ctx, {
          requestId,
          operation: "fetchAggregatedOptions",
          platform: "aggregator",
          level,
          parentSport: parentFilters?.sport,
          parentYear: parentFilters?.year,
          parentSetName: parentFilters?.setName,
          duration_ms: Date.now() - aggregatorStart,
          success: false,
          sl_ms: slDurationMs,
          bsc_ms: bscDurationMs,
          sl_success: slSuccess,
          bsc_success: bscSuccess,
          result_count: 0,
          stage: "aggregator",
          timed_out_platform: timedOutPlatform,
          error_class: classifyAdapterError(
            platformErrors.bsc || platformErrors.sportlots,
          ),
        });
        return {
          success: false,
          message: `No ${level} options returned from any platform. Check that credentials are configured for BSC and SportLots.`,
          optionsCount: 0,
        };
      }

      // 5. Store via mutation
      const result: { success: boolean; message: string; optionsCount: number } = await ctx.runMutation(
        api.selectorOptions.storeSelectorOptions,
        {
          level,
          options: deduped,
          parentId,
        },
      );

      // Surface partial-failure warnings in the user-visible message.
      // Without this, a platform that silently returns zero options looks
      // indistinguishable from "platform disabled" and regressions go
      // unnoticed until someone reads the PostHog dashboard.
      const warningSuffix =
        Object.keys(platformErrors).length > 0
          ? ` (Warnings: ${Object.entries(platformErrors)
              .map(([plat, err]) => `${plat}: ${err}`)
              .join("; ")})`
          : "";

      await recordAdapterCall(ctx, {
        requestId,
        operation: "fetchAggregatedOptions",
        platform: "aggregator",
        level,
        parentSport: parentFilters?.sport,
        parentYear: parentFilters?.year,
        parentSetName: parentFilters?.setName,
        duration_ms: Date.now() - aggregatorStart,
        success: result.success,
        sl_ms: slDurationMs,
        bsc_ms: bscDurationMs,
        sl_success: slSuccess,
        bsc_success: bscSuccess,
        result_count: result.optionsCount,
        stage: "aggregator",
        timed_out_platform: timedOutPlatform,
        error_class:
          Object.keys(platformErrors).length > 0
            ? classifyAdapterError(
                platformErrors.bsc || platformErrors.sportlots,
              )
            : undefined,
      });

      return {
        success: result.success,
        message: result.message + warningSuffix,
        optionsCount: result.optionsCount,
      };
    } catch (error) {
      console.error(`[fetchAggregatedOptions] Error:`, error);
      await recordAdapterCall(ctx, {
        requestId,
        operation: "fetchAggregatedOptions",
        platform: "aggregator",
        level: args.level,
        parentSport: args.parentFilters?.sport,
        parentYear: args.parentFilters?.year,
        parentSetName: args.parentFilters?.setName,
        duration_ms: Date.now() - aggregatorStart,
        success: false,
        result_count: 0,
        stage: "aggregator",
        error_class: classifyAdapterError(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return {
        success: false,
        message: `Failed to fetch options: ${error instanceof Error ? error.message : "Unknown error"}`,
        optionsCount: 0,
      };
    }
  },
});

/**
 * Fetch BSC sets for a sport/year and distribute them across existing
 * manufacturer parents by matching the set name prefix. Unmatched sets
 * go under "All Brands".
 */
export const syncSetsAcrossManufacturers = action({
  args: {
    yearId: v.id("selectorOptions"),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    totalSets: v.number(),
  }),
  handler: async (ctx, args): Promise<{ success: boolean; message: string; totalSets: number }> => {
    await requireAdmin(ctx);
    try {
      // 1. Build ancestor chain from yearId to get sport/year values + BSC slugs
      const chain: Array<{
        _id: Id<"selectorOptions">;
        level: Level;
        value: string;
        platformData: { bsc?: string | string[]; sportlots?: string };
        isCustom?: boolean;
      }> = await ctx.runQuery(
        api.selectorOptions.getAncestorChain,
        { id: args.yearId },
      );

      // Custom-subtree gate (NEO-22). A custom sport/year has no BSC
      // analogue; the downstream `fetchBscSelectorOptions` call would either
      // 404 or return an unrelated superset.
      if (isCustomSubtree(chain)) {
        return {
          success: true,
          message: "Custom sport/year — skipping BSC set sync.",
          totalSets: 0,
        };
      }

      const sportAncestor = chain.find((a: { level: string }) => a.level === "sport");
      const yearAncestor = chain.find((a: { level: string }) => a.level === "year");
      if (!sportAncestor || !yearAncestor) {
        return { success: false, message: "Could not resolve sport/year ancestors", totalSets: 0 };
      }

      // Build BSC filters (sport + year only)
      const bscPlatformFilters: Record<string, string[]> = {};
      if (sportAncestor.platformData?.bsc) {
        const v = sportAncestor.platformData.bsc;
        bscPlatformFilters.sport = Array.isArray(v) ? v : [v];
      } else {
        bscPlatformFilters.sport = [sportAncestor.value.toLowerCase()];
      }
      if (yearAncestor.platformData?.bsc) {
        const v = yearAncestor.platformData.bsc;
        bscPlatformFilters.year = Array.isArray(v) ? v : [v];
      } else {
        bscPlatformFilters.year = [yearAncestor.value.toLowerCase()];
      }

      // 2. Fetch sets from BSC
      const bscResult: { success: boolean; options: Array<{ value: string; platformValue: string }>; message?: string } = await ctx.runAction(
        api.adapters.buysportscards.fetchBscSelectorOptions,
        {
          level: "setName",
          parentFilters: {
            sport: sportAncestor.value,
            year: yearAncestor.value,
          },
          platformFilters: bscPlatformFilters,
        },
      );

      if (!bscResult.success || bscResult.options.length === 0) {
        return {
          success: false,
          message: bscResult.message || "No sets returned from BSC",
          totalSets: 0,
        };
      }

      console.log(`[syncSetsAcrossManufacturers] BSC returned ${bscResult.options.length} sets`);

      // 3. Get all manufacturers for this year
      const manufacturers = await ctx.runQuery(
        api.selectorOptions.getSelectorOptions,
        { level: "manufacturer", parentId: args.yearId },
      );

      // Build a lookup: normalized manufacturer name → manufacturer doc
      const mfrLookup = new Map<string, { _id: Id<"selectorOptions">; value: string }>();
      let allBrandsId: Id<"selectorOptions"> | null = null;

      for (const mfr of manufacturers) {
        const norm = mfr.value.toLowerCase().trim();
        mfrLookup.set(norm, { _id: mfr._id, value: mfr.value });
        if (norm === "all brands") {
          allBrandsId = mfr._id;
        }
      }

      // Create "All Brands" if it doesn't exist
      if (!allBrandsId) {
        allBrandsId = await ctx.runMutation(
          api.selectorOptions.addCustomSelectorOption,
          {
            level: "manufacturer",
            value: "All Brands",
            parentId: args.yearId,
          },
        );
      }

      // 4. Match each BSC set to a manufacturer by prefix
      // Sort manufacturers by name length descending so "Upper Deck" matches
      // before "Upper" and more specific names win.
      const sortedMfrs = [...mfrLookup.entries()].sort(
        (a, b) => b[0].length - a[0].length,
      );

      const grouped = new Map<string, Array<{ value: string; platformValue: string }>>();

      for (const set of bscResult.options) {
        const setNameLower = set.value.toLowerCase().trim();
        let matchedMfrId: string | null = null;

        for (const [mfrName, mfr] of sortedMfrs) {
          if (mfrName === "all brands") continue;
          if (setNameLower.startsWith(mfrName + " ") || setNameLower === mfrName) {
            matchedMfrId = mfr._id;
            break;
          }
        }

        const parentId = matchedMfrId || allBrandsId!;
        if (!grouped.has(parentId)) {
          grouped.set(parentId, []);
        }
        grouped.get(parentId)!.push(set);
      }

      // 5. Store sets under each manufacturer
      let totalStored = 0;
      for (const [parentId, sets] of grouped) {
        const result = await ctx.runMutation(
          api.selectorOptions.storeSelectorOptions,
          {
            level: "setName",
            parentId: parentId as Id<"selectorOptions">,
            options: sets.map((s) => ({
              value: s.value,
              platformData: { bsc: s.platformValue },
            })),
          },
        );
        totalStored += result.optionsCount;
      }

      // Build summary
      const summary: string[] = [];
      for (const [parentId, sets] of grouped) {
        const mfr = manufacturers.find((m: { _id: string }) => m._id === parentId);
        const name = mfr?.value || "All Brands";
        summary.push(`${name}: ${sets.length}`);
      }

      return {
        success: true,
        message: `Distributed ${totalStored} sets across manufacturers (${summary.join(", ")})`,
        totalSets: totalStored,
      };
    } catch (error) {
      console.error("[syncSetsAcrossManufacturers] Error:", error);
      return {
        success: false,
        message: `Failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        totalSets: 0,
      };
    }
  },
});

/**
 * Lowercase + strip punctuation + token-sort. Same shape as
 * normalizePlayerName/normalizeTeamName in convex/players.ts and
 * convex/teams.ts — kept inline here to avoid pulling those modules into
 * the action runtime (Convex bundles per-file). Used both for fuzzy
 * matching during reconciliation and for matching against the existing
 * players/teams tables.
 */
function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,'"`’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

/**
 * Jaro similarity between two strings. Returns 0..1. Implementation
 * follows the canonical algorithm: count matching characters within a
 * window of floor(max(|a|,|b|)/2)-1 positions, then count transpositions.
 */
function jaroSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchDistance = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatches = new Array(a.length).fill(false);
  const bMatches = new Array(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatches[j] || a[i] !== b[j]) continue;
      aMatches[i] = true;
      bMatches[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatches[i]) continue;
    while (!bMatches[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  return (
    (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3
  );
}

/**
 * Jaro-Winkler — Jaro plus a prefix bonus that rewards strings sharing
 * an initial prefix. Used for player-name reconciliation across BSC and
 * SportLots when card numbers don't match (parallels, inserts with
 * different numbering schemes between marketplaces).
 *
 * Threshold of 0.92 picks up "Mike Trout" ≈ "Michael Trout" while
 * keeping "Mike Trout" and "Mike Stanton" distinct.
 */
function jaroWinkler(a: string, b: string): number {
  const jaro = jaroSimilarity(a, b);
  let prefix = 0;
  const max = Math.min(4, a.length, b.length);
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

interface ReconciledCard {
  cardNumber: string;
  cardName: string;
  team?: string;
  teams?: string[];
  players?: string[];
  attributes?: string[];
  isRookie?: boolean;
  isRelic?: boolean;
  printRun?: number;
  autographType?: string;
  cardVariation?: string;
  platformData: { bsc?: string; sportlots?: string };
  // NEO-6: per-card source set IDs when the variant has multiple attached.
  // Drives the "Series 1 / Series 2" filter and the per-card source badge.
  sourcePlatformIds?: { bsc?: string; sportlots?: string };
  /**
   * Reconciliation marker for cards that landed on only one side. UI
   * surfaces these as needing human review; reconciled cards (from both
   * sides) carry no such tag.
   */
  unmatched?: "bsc" | "sl";
}

const previewCardValidator = v.object({
  cardNumber: v.string(),
  cardName: v.string(),
  team: v.optional(v.string()),
  teams: v.optional(v.array(v.string())),
  players: v.optional(v.array(v.string())),
  attributes: v.optional(v.array(v.string())),
  isRookie: v.optional(v.boolean()),
  isRelic: v.optional(v.boolean()),
  printRun: v.optional(v.number()),
  autographType: v.optional(v.string()),
  cardVariation: v.optional(v.string()),
  platformData: v.object({
    bsc: v.optional(v.string()),
    sportlots: v.optional(v.string()),
  }),
  // NEO-6: source set IDs per side (only populated when variant has
  // multiple attached IDs on that side).
  sourcePlatformIds: v.optional(
    v.object({
      bsc: v.optional(v.string()),
      sportlots: v.optional(v.string()),
    }),
  ),
  unmatched: v.optional(v.union(v.literal("bsc"), v.literal("sl"))),
});

/**
 * Action — fetch reconciled checklist preview without persisting.
 *
 * Pipeline:
 *   1. Resolve ancestor chain → sport, year, set/variant filters
 *   2. Fetch BSC + SL in parallel; tolerate single-side failure
 *   3. Reconcile by cardNumber (with cardNumberPrefix from selectorOption
 *      metadata applied), then BSC→SL cross-ref via BSC.sportlotsRef,
 *      then Jaro-Winkler ≥ 0.92 fuzzy match on player names
 *   4. Bucket player/team names against existing players/teams tables
 *      → return `unknownPlayers` / `unknownTeams` for the dialog
 *
 * Persistence happens in commitCardChecklist after the user confirms
 * unknowns. Splitting fetch/commit lets the dialog gate entity creation
 * — per the explicit requirement that the user confirm new players/
 * teams before they hit the database.
 */
export const fetchCardChecklist = action({
  args: {
    selectorOptionId: v.id("selectorOptions"),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    sport: v.optional(v.string()),
    cards: v.array(previewCardValidator),
    unknownPlayers: v.array(v.string()),
    unknownTeams: v.array(v.string()),
    // NEO-92: present whenever unknownPlayers/unknownTeams is non-empty —
    // the review wizard subscribes to this batch via entityReviewQueue.
    batchId: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{
    success: boolean;
    message: string;
    sport?: string;
    cards: Array<{
      cardNumber: string;
      cardName: string;
      team?: string;
      teams?: string[];
      players?: string[];
      attributes?: string[];
      isRookie?: boolean;
      isRelic?: boolean;
      printRun?: number;
      autographType?: string;
      cardVariation?: string;
      platformData: { bsc?: string; sportlots?: string };
      sourcePlatformIds?: { bsc?: string; sportlots?: string };
      unmatched?: "bsc" | "sl";
    }>;
    unknownPlayers: string[];
    unknownTeams: string[];
    batchId?: string;
  }> => {
    try {
      // Resolve ancestor chain → filter map + sport + cardNumberPrefix
      const chain = await ctx.runQuery(
        api.selectorOptions.getAncestorChain,
        { id: args.selectorOptionId },
      );

      const filters: Record<string, string> = {};
      // NEO-6: both sides may now be arrays at any level. We keep the
      // arrays here and fan out / pass through downstream.
      const slPlatformFilters: Record<string, string[]> = {};
      const bscPlatformFilters: Record<string, string[]> = {};
      let sport: string | undefined;
      let cardNumberPrefix: string | undefined;

      for (const ancestor of chain) {
        filters[ancestor.level] = ancestor.value;
        if (ancestor.level === "sport") sport = ancestor.value.toLowerCase();
        if (ancestor.metadata?.cardNumberPrefix) {
          cardNumberPrefix = ancestor.metadata.cardNumberPrefix;
        }
        if (ancestor.platformData?.sportlots) {
          const slVal = ancestor.platformData.sportlots;
          slPlatformFilters[ancestor.level] = Array.isArray(slVal) ? slVal : [slVal];
        }
        if (ancestor.platformData?.bsc) {
          const bscVal = ancestor.platformData.bsc;
          bscPlatformFilters[ancestor.level] = Array.isArray(bscVal) ? bscVal : [bscVal];
        }
      }

      // Custom-subtree gate (NEO-22). If any node in the chain (including the
      // leaf) is user-created, every descendant is implicitly custom. BSC and
      // SportLots have no concept of these rows: querying them would either
      // 404 or — worse — widen the query to an unrelated superset (the old
      // BSC fallback would return the entire `variantType=insert` universe,
      // ~5000 cards, when a custom parallel-of-insert had no slug). Return
      // empty results so the UI can only offer custom children downstream.
      if (isCustomSubtree(chain)) {
        console.log(
          `[fetchCardChecklist] custom subtree detected — skipping BSC/SL`,
        );
        return {
          success: true,
          message:
            "Custom selector subtree — no marketplace data available; add custom cards.",
          sport,
          cards: [],
          unknownPlayers: [],
          unknownTeams: [],
        };
      }

      // Data-integrity precondition for BSC only. BSC is a stable service
      // that consistently returns data for properly-filtered queries; a
      // 0-card result almost always means our filter was incomplete.
      // Surface this loudly instead of silently sending an under-filtered
      // request and treating the empty response as "the marketplace had
      // nothing".
      //
      // Required BSC platform data: sport, year, setName. These are the
      // levels where BSC has a canonical slug (per LEVEL_TO_BSC_FACET in
      // adapters/buysportscards.ts) AND where the slug is required for a
      // properly filtered query.
      //
      // The custom-subtree gate above already short-circuits any chain that
      // contains a user-created node, so by the time we reach this check
      // every ancestor is sourced from a marketplace and is expected to
      // carry BSC platform data at the required levels.
      //
      // SL is not preconditioned: per `sportlots.ts:160-164`, SL
      // deliberately returns no options at setName/variantType (SL's
      // data model combines set+variant at the "insert" level), and
      // `fetchSportLotsChecklist` resolves the radio-button ID itself
      // when no SL slug is passed in.
      const BSC_REQUIRED_LEVELS = new Set(["sport", "year", "setName"]);
      const missingBsc: string[] = [];
      for (const ancestor of chain) {
        if (BSC_REQUIRED_LEVELS.has(ancestor.level) && !ancestor.platformData?.bsc) {
          missingBsc.push(`${ancestor.level}=${ancestor.value}`);
        }
      }
      if (missingBsc.length > 0) {
        const msg =
          `Cannot fetch checklist — ancestor rows are missing BSC platform slugs ` +
          `on: ${missingBsc.join(", ")}. Upstream selectorOptions hydration did ` +
          `not write the BSC slugs we need (this is a bug in our sync pipeline, ` +
          `not a marketplace issue).`;
        console.error(`[fetchCardChecklist] precondition failed: ${msg}`);
        return {
          success: false,
          message: msg,
          sport,
          cards: [],
          unknownPlayers: [],
          unknownTeams: [],
        };
      }

      console.log(
        `[fetchCardChecklist] sport=${sport} prefix=${cardNumberPrefix}`,
        `filters:`, filters,
      );

      // NEO-6: SL adapter takes one set ID at a time. When the active
      // SL level has multiple attached IDs (operator-attached extras),
      // fan out one call per ID and tag each returned card with its
      // source set ID. Dedup by cardNumber across the merged result —
      // first source wins, conflicts are logged.
      type SlCard = {
        cardNumber: string;
        cardName: string;
        team?: string;
        teams?: string[];
        players?: string[];
        attributes?: string[];
        printRun?: number;
        autographType?: string;
        cardVariation?: string;
        platformRef?: string;
        sportlotsRef?: string;
        sourceSlSetId?: string;
      };

      // Find which level (if any) has multiple attached SL IDs. Phase 1
      // expects this only at variantType/insert/parallel rows; warn if it
      // appears elsewhere so we notice unexpected data shape.
      //
      // Cap to MAX_SL_FAN_OUT to bound the number of parallel SL HTTP
      // calls per fetch (matches `MAX_ATTACHED_PER_SIDE` on the attach
      // path; defense-in-depth in case extras were attached pre-cap).
      const MAX_SL_FAN_OUT = 10;
      const slFanOut: { level: string; ids: string[] } | null = (() => {
        for (const [lvl, ids] of Object.entries(slPlatformFilters)) {
          if (ids.length > 1) {
            if (!["variantType", "insert", "parallel"].includes(lvl)) {
              console.warn(
                `[fetchCardChecklist] unexpected multi-SL at level=${lvl} (phase-1 expects variant levels only)`,
              );
            }
            const cappedIds = ids.slice(0, MAX_SL_FAN_OUT);
            if (cappedIds.length < ids.length) {
              console.warn(
                `[fetchCardChecklist] SL fan-out capped at ${MAX_SL_FAN_OUT} (had ${ids.length} attached at level=${lvl})`,
              );
            }
            return { level: lvl, ids: cappedIds };
          }
        }
        return null;
      })();

      const callSl = async (
        perCallFilters: Record<string, string>,
        sourceId: string | undefined,
      ): Promise<SlCard[]> => {
        const result = await ctx.runAction(
          api.adapters.sportlots.fetchSportLotsChecklist,
          {
            parentFilters: filters,
            platformFilters: perCallFilters,
          },
        ).catch((err) => {
          console.error(`[fetchCardChecklist] SportLots error:`, err);
          return { success: false, cards: [] as SlCard[], message: String(err) };
        });
        if (!result.success) return [];
        return (result.cards as SlCard[]).map((c) => ({
          ...c,
          sourceSlSetId: sourceId,
        }));
      };

      // SL and BSC are independent network fetches. Run both concurrently
      // with Promise.allSettled so one marketplace's outage can never reject
      // the other.

      const fetchSl = async (): Promise<SlCard[]> => {
        // Adapter signature is record<string,string>; flatten single-ID
        // entries down to scalars. Multi-ID entries are handled by fanning
        // out one call per ID at the fan-out level.
        const singletonFilters: Record<string, string> = {};
        for (const [lvl, ids] of Object.entries(slPlatformFilters)) {
          if (ids.length === 1) singletonFilters[lvl] = ids[0];
        }
        if (!slFanOut) {
          // No fan-out needed; single call (still tag source id when
          // exactly one SL set is attached at a variant level).
          const variantSlIds = ["variantType", "insert", "parallel"]
            .map((lvl) => slPlatformFilters[lvl]?.[0])
            .filter(Boolean) as string[];
          const sourceId =
            variantSlIds.length > 0 ? variantSlIds[variantSlIds.length - 1] : undefined;
          return await callSl(singletonFilters, sourceId);
        }
        // Multi-ID fan-out: one call per ID at the fan-out level.
        const perIdResults = await Promise.all(
          slFanOut.ids.map((slId) => {
            const perCall = { ...singletonFilters, [slFanOut.level]: slId };
            return callSl(perCall, slId);
          }),
        );
        // Dedup by cardNumber — first occurrence wins.
        const dedup = new Map<string, SlCard>();
        for (const cards of perIdResults) {
          for (const c of cards) {
            const existing = dedup.get(c.cardNumber);
            if (!existing) {
              dedup.set(c.cardNumber, c);
            } else if (existing.sourceSlSetId !== c.sourceSlSetId) {
              console.warn(
                `[fetchCardChecklist] SL cardNumber collision: ${c.cardNumber} ` +
                  `keptSource=${existing.sourceSlSetId} skippedSource=${c.sourceSlSetId}`,
              );
            }
          }
        }
        return Array.from(dedup.values());
      };

      type BscFetchResult = {
        success: boolean;
        cards: any[];
        message?: string;
      };
      const fetchBsc = async (): Promise<BscFetchResult> => {
        // BSC's bulk-upload API accepts multi-value facets in one call and
        // tags each card with its source set slug — no fan-out needed.
        return await ctx.runAction(
          api.adapters.buysportscards.fetchBscChecklist,
          {
            parentFilters: filters,
            platformFilters: bscPlatformFilters,
          },
        ).catch((err) => {
          console.error(`[fetchCardChecklist] BSC error:`, err);
          return { success: false, cards: [] as any[], message: String(err) };
        });
      };

      const [slSettled, bscSettled] = await Promise.allSettled([
        fetchSl(),
        fetchBsc(),
      ]);

      const slCards: SlCard[] =
        slSettled.status === "fulfilled" ? slSettled.value : [];
      const bscResult: BscFetchResult =
        bscSettled.status === "fulfilled"
          ? bscSettled.value
          : { success: false, cards: [] };

      const bscCards = (bscResult.success ? bscResult.cards : []) as Array<{
        cardNumber: string;
        cardName: string;
        team?: string;
        teams?: string[];
        players?: string[];
        attributes?: string[];
        printRun?: number;
        autographType?: string;
        cardVariation?: string;
        platformRef?: string;
        sportlotsRef?: string;
        sourceBscSetSlug?: string;
      }>;

      // Index SL by both cardNumber and (after prefix-strip) for prefix-aware
      // BSC matching, AND by sportlotsRef so BSC's built-in cross-reference
      // can short-circuit fuzzy matching.
      const slByNumber = new Map<string, typeof slCards[0]>();
      const slByRef = new Map<string, typeof slCards[0]>();
      for (const c of slCards) {
        slByNumber.set(c.cardNumber, c);
        if (c.sportlotsRef) slByRef.set(c.sportlotsRef, c);
      }

      const out: ReconciledCard[] = [];
      const claimedSlNumbers = new Set<string>();

      // 1. Walk BSC, attach matching SL data
      for (const bsc of bscCards) {
        const stripped = cardNumberPrefix && bsc.cardNumber.startsWith(cardNumberPrefix)
          ? bsc.cardNumber.slice(cardNumberPrefix.length)
          : bsc.cardNumber;

        let sl: typeof slCards[0] | undefined =
          (bsc.sportlotsRef && slByRef.get(bsc.sportlotsRef))
          || slByNumber.get(bsc.cardNumber)
          || slByNumber.get(stripped);

        // 2. Fuzzy fallback: pick the unclaimed SL card whose first player
        //    name is most similar to BSC's first player. Threshold 0.92.
        if (!sl && bsc.players?.[0]) {
          const target = normalizeName(bsc.players[0]);
          let best: { card: typeof slCards[0]; score: number } | null = null;
          for (const candidate of slCards) {
            if (claimedSlNumbers.has(candidate.cardNumber)) continue;
            const candName = candidate.cardName ? normalizeName(candidate.cardName) : "";
            if (!candName) continue;
            const score = jaroWinkler(target, candName);
            if (score >= 0.92 && (!best || score > best.score)) {
              best = { card: candidate, score };
            }
          }
          if (best) sl = best.card;
        }

        if (sl) claimedSlNumbers.add(sl.cardNumber);

        const attributes = Array.from(new Set([
          ...(bsc.attributes ?? []),
          ...(sl?.attributes ?? []),
        ]));
        const printRun = bsc.printRun ?? sl?.printRun;
        const players = bsc.players ?? (sl?.players ?? undefined);
        const teamsArr = bsc.teams ?? (sl?.teams ?? undefined);

        const sourcePlatformIds =
          bsc.sourceBscSetSlug || sl?.sourceSlSetId
            ? {
                bsc: bsc.sourceBscSetSlug,
                sportlots: sl?.sourceSlSetId,
              }
            : undefined;

        out.push({
          cardNumber: bsc.cardNumber,
          cardName: bsc.cardName || sl?.cardName || `Card #${bsc.cardNumber}`,
          team: bsc.team ?? sl?.team,
          teams: teamsArr,
          players,
          attributes: attributes.length ? attributes : undefined,
          isRookie: attributes.includes("RC") || undefined,
          isRelic: attributes.includes("RELIC") || undefined,
          printRun,
          autographType: bsc.autographType ?? sl?.autographType,
          cardVariation: bsc.cardVariation,
          platformData: {
            bsc: bsc.platformRef,
            sportlots: sl?.platformRef,
          },
          sourcePlatformIds,
        });
      }

      // 3. SL cards never claimed by BSC: emit as unmatched-bsc rows so
      //    a human can review (they may be valid cards BSC's seller catalog
      //    doesn't carry, or genuine numbering mismatches we should fix).
      for (const sl of slCards) {
        if (claimedSlNumbers.has(sl.cardNumber)) continue;
        out.push({
          cardNumber: sl.cardNumber,
          cardName: sl.cardName || `Card #${sl.cardNumber}`,
          team: sl.team,
          teams: sl.teams,
          players: sl.players,
          attributes: sl.attributes,
          isRookie: sl.attributes?.includes("RC") || undefined,
          isRelic: sl.attributes?.includes("RELIC") || undefined,
          printRun: sl.printRun,
          autographType: sl.autographType,
          platformData: { sportlots: sl.platformRef },
          sourcePlatformIds: sl.sourceSlSetId
            ? { sportlots: sl.sourceSlSetId }
            : undefined,
          unmatched: "bsc",
        });
      }

      // 4. NEO-90: resolve team names for regular BSC cards that don't
      //    already have one from the cheap synchronous parse (TC-suffix /
      //    parenthetical — see parsePlayersField). This is the only place
      //    that pays a per-card network cost, done once as a single bounded
      //    fan-out so team names land in the SAME confirm dialog as new
      //    players below, instead of trickling in via the background
      //    enrichment queue after save. SportLots-only cards (no BSC ref)
      //    are skipped — this feature is BSC-only.
      const needsTeamLookup = out.filter(
        (c) => !c.teams?.length && !c.team && c.platformData.bsc,
      );
      if (needsTeamLookup.length > 0) {
        const teamNames: Record<string, string> = await ctx.runAction(
          internal.adapters.buysportscards.fetchBscCardTeamNames,
          { bscCardIds: needsTeamLookup.map((c) => c.platformData.bsc!) },
        );
        for (const c of needsTeamLookup) {
          const name = teamNames[c.platformData.bsc!];
          if (name) c.teams = [name];
        }
      }

      // 5. Bucket unique player + team names against existing tables.
      //    Deduped by NORMALIZED name (not raw trimmed string) — two
      //    spellings of one player ("Ken Griffey Jr." vs "Ken Griffey Jr")
      //    used to produce two separate unknowns + two Wikidata lookups;
      //    first-seen display spelling wins. Skip bucketing entirely if we
      //    can't infer sport (sets without a sport ancestor — shouldn't
      //    happen but guard anyway).
      const unknownPlayers: string[] = [];
      const unknownTeams: string[] = [];
      let batchId: string | undefined;
      if (sport) {
        const playerByNorm = new Map<string, string>();
        const teamByNorm = new Map<string, string>();
        const addPlayer = (raw: string) => {
          const trimmed = raw.trim();
          if (!trimmed) return;
          const norm = normalizePlayerName(trimmed);
          if (!playerByNorm.has(norm)) playerByNorm.set(norm, trimmed);
        };
        const addTeam = (raw: string) => {
          const trimmed = raw.trim();
          if (!trimmed) return;
          const norm = normalizeTeamName(trimmed);
          if (!teamByNorm.has(norm)) teamByNorm.set(norm, trimmed);
        };

        for (const c of out) {
          for (const p of c.players ?? []) addPlayer(p);
          for (const t of c.teams ?? []) addTeam(t);
          if (c.team && !c.teams?.length) addTeam(c.team);
        }

        // Custom cards (added via addCustomCard) can declare pending player /
        // team names that should also be surfaced as unknown until the user
        // confirms them via the wizard. Without this pass, users who add a
        // custom card for a brand-new player would never get prompted to
        // enrich that player via the standard confirmation flow.
        const customRows = await ctx.runQuery(
          api.selectorOptions.getCardChecklist,
          { selectorOptionId: args.selectorOptionId },
        );
        for (const r of customRows) {
          for (const p of r.pendingPlayerNames ?? []) addPlayer(p);
          for (const t of r.pendingTeamNames ?? []) addTeam(t);
        }

        for (const name of playerByNorm.values()) {
          const existing = await ctx.runQuery(api.players.findByNameAndSport, { name, sport });
          if (!existing) unknownPlayers.push(name);
        }
        for (const name of teamByNorm.values()) {
          const existing = await ctx.runQuery(api.teams.findByNameAndSport, { name, sport });
          if (!existing) unknownTeams.push(name);
        }

        // NEO-92: kick off the review-wizard batch (background Wikidata
        // preview lookups + resumable decision queue) for whatever's
        // unresolved. startBatch resumes an in-progress batch for this
        // (selectorOptionId, user) pair rather than restarting it, so
        // re-clicking "Fetch from Marketplaces" mid-review never discards
        // progress — and is scoped per-user so two different sessions
        // fetching the SAME real set never share/collide on one batch.
        if (unknownPlayers.length > 0 || unknownTeams.length > 0) {
          const callerId = await getCurrentUserId(ctx);
          if (!callerId) throw new Error("Not authenticated");
          batchId = await ctx.runMutation(internal.entityReviewQueue.startBatch, {
            selectorOptionId: args.selectorOptionId,
            createdByUserId: callerId,
            sport,
            playerNames: unknownPlayers,
            teamNames: unknownTeams,
          });
        }
      }

      console.log(
        `[fetchCardChecklist] reconciled ${out.length} cards`,
        `(${unknownPlayers.length} new players, ${unknownTeams.length} new teams)`,
      );

      return {
        success: true,
        message: `Found ${out.length} cards${unknownPlayers.length || unknownTeams.length ? `; ${unknownPlayers.length} new players + ${unknownTeams.length} new teams need confirmation` : ""}`,
        sport,
        cards: out,
        unknownPlayers,
        unknownTeams,
        batchId,
      };
    } catch (error) {
      console.error(`[fetchCardChecklist] Error:`, error);
      return {
        success: false,
        message: `Failed to fetch checklist: ${error instanceof Error ? error.message : "Unknown error"}`,
        cards: [],
        unknownPlayers: [],
        unknownTeams: [],
      };
    }
  },
});

/**
 * Mutation — commit a fetched checklist preview. Every player/team name
 * that isn't already in our tables was reviewed one-at-a-time in the
 * NEO-92 review wizard (batchId → entityReviewQueue), which recorded a
 * `decision` of "create" (seeded from the wizard's own Wikidata preview
 * lookup) or "link" (an existing player/team the user picked instead —
 * no new row). There is no skip: every name resolves to one or the other.
 * Card playerIds/teamOnCardIds are resolved from those decisions, the
 * checklist is persisted, and the batch's review rows are cleaned up.
 */
export const commitCardChecklist = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    sport: v.string(),
    cards: v.array(previewCardValidator),
    // Present whenever the fetch surfaced unknown names (and the wizard
    // ran); absent on the zero-unknowns fast path.
    batchId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    count: v.number(),
    createdPlayerIds: v.array(v.id("players")),
    createdTeamIds: v.array(v.id("teams")),
  }),
  handler: async (ctx, args): Promise<{
    success: boolean;
    count: number;
    createdPlayerIds: Array<Id<"players">>;
    createdTeamIds: Array<Id<"teams">>;
  }> => {
    await requireAdmin(ctx);
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // Helper — same normalization as players.ts/teams.ts
    const norm = (s: string) =>
      s.toLowerCase()
        .replace(/[.,'"`’]/g, "")
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/\s+/)
        .filter(Boolean)
        .sort()
        .join(" ");

    // Resolve every player/team name appearing on any card to an Id where
    // possible. Build name → Id maps so the per-card resolution below is
    // O(1) instead of repeated DB lookups.
    const allPlayerNames = new Set<string>();
    const allTeamNames = new Set<string>();
    for (const c of args.cards) {
      for (const p of c.players ?? []) if (p.trim()) allPlayerNames.add(p.trim());
      for (const t of c.teams ?? []) if (t.trim()) allTeamNames.add(t.trim());
      if (c.team && c.team.trim() && !c.teams?.length) allTeamNames.add(c.team.trim());
    }

    // Fold in pending* names from custom cards on this variant. Those rows
    // aren't in args.cards (which is the BSC/SL fetch preview), so without
    // this pass a reviewed custom-card pending player would never get
    // inserted into the players table.
    const existingForPending = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();
    for (const r of existingForPending) {
      if (!r.isCustom) continue;
      for (const p of r.pendingPlayerNames ?? []) {
        if (p.trim()) allPlayerNames.add(p.trim());
      }
      for (const t of r.pendingTeamNames ?? []) {
        if (t.trim()) allTeamNames.add(t.trim());
      }
    }

    // NEO-92: load this batch's reviewed decisions (create/link, no skip —
    // see the wizard). Keyed by kind+normalized-name so a player and a team
    // that happen to share a normalized name never collide.
    const reviewRows = args.batchId
      ? await ctx.db
          .query("entityReviewQueue")
          .withIndex("by_selector_option_and_batch", (q) =>
            q
              .eq("selectorOptionId", args.selectorOptionId)
              .eq("batchId", args.batchId!),
          )
          .collect()
      : [];
    const reviewByKey = new Map<string, (typeof reviewRows)[number]>();
    for (const row of reviewRows) {
      reviewByKey.set(`${row.kind}:${norm(row.name)}`, row);
    }

    // Get-or-create a bare team row by name — used to resolve a newly
    // created player's career-team names (from the wizard's Wikidata
    // preview) to real team ids. Deliberately minimal (no enrichment
    // fields) since these are incidental historical teams, not something
    // the user reviewed directly — same behavior as today's
    // teams.findOrCreateInternal, inlined here since a mutation can't call
    // another mutation via ctx.runMutation.
    const resolveTeamIdByName = async (rawName: string): Promise<Id<"teams">> => {
      const normalized = norm(rawName);
      const existing = await ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport", (q) =>
          q.eq("nameNormalized", normalized).eq("sport", args.sport),
        )
        .first();
      if (existing) return existing._id;
      return await ctx.db.insert("teams", {
        name: rawName.trim(),
        nameNormalized: normalized,
        sport: args.sport,
        lastUpdated: Date.now(),
      });
    };

    const playerIdByName = new Map<string, Id<"players">>();
    const createdPlayerIds: Array<Id<"players">> = [];
    for (const name of allPlayerNames) {
      const normalized = norm(name);
      // Compound index returns 0 or 1 row per lookup — independent of how
      // many cross-sport duplicates of this normalized name exist.
      const existing = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport", (q) =>
          q.eq("nameNormalized", normalized).eq("primarySport", args.sport),
        )
        .first();
      if (existing) {
        playerIdByName.set(name, existing._id);
        continue;
      }
      const decision = reviewByKey.get(`player:${normalized}`)?.decision;
      if (!decision) continue; // not reviewed — shouldn't happen; card keeps this name unresolved
      if (decision.action === "link") {
        if (decision.linkedPlayerId) playerIdByName.set(name, decision.linkedPlayerId);
        continue;
      }
      // decision.action === "create" — seed directly from the wizard's own
      // Wikidata preview lookup (already fetched during review); no more
      // post-commit processEnrichmentQueue scheduling needed for this row.
      const enrichment = reviewByKey.get(`player:${normalized}`)?.enrichment;
      const teamYears: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }> = [];
      for (const ct of enrichment?.careerTeams ?? []) {
        const teamId = await resolveTeamIdByName(ct.name);
        teamYears.push({ teamId, fromYear: ct.fromYear, toYear: ct.toYear });
      }
      const id = await ctx.db.insert("players", {
        name: name.trim(),
        nameNormalized: normalized,
        primarySport: args.sport,
        createdByUserId: userId,
        lastUpdated: Date.now(),
        ...(teamYears.length ? { teamYears } : {}),
        ...(enrichment?.isHallOfFame !== undefined
          ? { isHallOfFame: enrichment.isHallOfFame }
          : {}),
        ...(enrichment?.wikidataId
          ? { externalIds: { wikidataId: enrichment.wikidataId } }
          : {}),
      });
      playerIdByName.set(name, id);
      createdPlayerIds.push(id);
    }

    const teamIdByName = new Map<string, Id<"teams">>();
    const createdTeamIds: Array<Id<"teams">> = [];
    for (const name of allTeamNames) {
      const normalized = norm(name);
      const existing = await ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport", (q) =>
          q.eq("nameNormalized", normalized).eq("sport", args.sport),
        )
        .first();
      if (existing) {
        teamIdByName.set(name, existing._id);
        continue;
      }
      const decision = reviewByKey.get(`team:${normalized}`)?.decision;
      if (!decision) continue;
      if (decision.action === "link") {
        if (decision.linkedTeamId) teamIdByName.set(name, decision.linkedTeamId);
        continue;
      }
      const enrichment = reviewByKey.get(`team:${normalized}`)?.enrichment;
      const id = await ctx.db.insert("teams", {
        name: name.trim(),
        nameNormalized: normalized,
        sport: args.sport,
        lastUpdated: Date.now(),
        ...(enrichment?.league ? { league: enrichment.league } : {}),
        ...(enrichment?.city ? { city: enrichment.city } : {}),
        ...(enrichment?.yearsActive ? { yearsActive: enrichment.yearsActive } : {}),
        ...(enrichment?.colors ? { colors: enrichment.colors } : {}),
        ...(enrichment?.wikidataId || enrichment?.espnId
          ? {
              externalIds: {
                wikidataId: enrichment?.wikidataId,
                espnId: enrichment?.espnId,
              },
            }
          : {}),
      });
      teamIdByName.set(name, id);
      createdTeamIds.push(id);
    }

    // Resolve per-card playerIds / teamOnCardIds. Cards whose names are
    // all skipped end up with empty arrays (left undefined).
    const richCards = args.cards.map((c) => {
      const playerIds: Array<Id<"players">> = [];
      for (const p of c.players ?? []) {
        const id = playerIdByName.get(p.trim());
        if (id) playerIds.push(id);
      }
      const teamOnCardIds: Array<Id<"teams">> = [];
      const teamSources = c.teams?.length ? c.teams : c.team ? [c.team] : [];
      for (const t of teamSources) {
        const id = teamIdByName.get(t.trim());
        if (id) teamOnCardIds.push(id);
      }
      return {
        cardNumber: c.cardNumber,
        cardName: c.cardName,
        // NEO-26: legacy `team` no longer emitted. The free-text string
        // from the adapter is consumed above to resolve teamOnCardIds[];
        // it isn't written to cardChecklist anywhere.
        playerIds: playerIds.length ? playerIds : undefined,
        teamOnCardIds: teamOnCardIds.length ? teamOnCardIds : undefined,
        attributes: c.unmatched
          ? Array.from(new Set([...(c.attributes ?? []), `unmatched-${c.unmatched}`]))
          : c.attributes,
        isRookie: c.isRookie,
        isRelic: c.isRelic,
        printRun: c.printRun,
        autographType: c.autographType,
        cardVariation: c.cardVariation,
        platformData: c.platformData,
        sourcePlatformIds: c.sourcePlatformIds,
      };
    });

    // Same delete-stale-rows behavior as before, inlined here so we can
    // keep the rich-card persistence path under a single mutation entry.
    const existingCards = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();
    const existingByNumber = new Map<string, typeof existingCards[0]>();
    for (const card of existingCards) existingByNumber.set(card.cardNumber, card);
    const processedNumbers = new Set<string>();

    // NEO-71-74: every selectorOptions row is a complete, self-contained
    // `features` snapshot at all times (copy-down happens once, at each
    // row's own creation — see storeSelectorOptions/addCustomSelectorOption/
    // storeReconciledOptions in this file and convex/setReconciliation.ts).
    // No ancestor walk or commit-time seeding needed for inheritance
    // anymore: the leaf node IS the fully resolved snapshot. (This replaces
    // the old NEO-38 commit-time seed, which also had a real, independent
    // cost — cascading from an ancestor as high as the sport node touched
    // that sport's entire catalog subtree on every single checklist commit.)
    const leafNode = await ctx.db.get(args.selectorOptionId);
    const inheritedFeaturesOrUndefined: Record<string, string> | undefined =
      leafNode?.features && Object.keys(leafNode.features).length > 0
        ? leafNode.features
        : undefined;

    // Still need the nearest setName ancestor id below (unrelated to
    // features — used only for the totalCardCount/lastSyncedAt patch).
    let setNameAncestorId: Id<"selectorOptions"> | undefined =
      leafNode?.level === "setName" ? leafNode._id : undefined;
    if (!setNameAncestorId) {
      let cursorId: Id<"selectorOptions"> | undefined = leafNode?.parentId;
      while (cursorId && !setNameAncestorId) {
        const node: any = await ctx.db.get(cursorId);
        if (!node) break;
        if (node.level === "setName") setNameAncestorId = node._id;
        cursorId = node.parentId;
      }
    }
    // Fetched once for the whole batch (not per-card) — used only for
    // listing-title/description generation on newly-inserted rows below.
    const setNameValue = setNameAncestorId
      ? (await ctx.db.get(setNameAncestorId))?.value
      : undefined;

    // NEO-71-74: per-card features come from the leaf node's already-complete
    // `features` snapshot (`inheritedFeaturesOrUndefined`, read above) merged
    // with the shared `deriveCardObservedFeatures` helper (isRookie/isRelic/
    // signedBy/parallelName — observed on this card only). The result is
    // written only for NEW card rows; existing rows are owned by
    // `setCardFeature` (operator overrides must not be clobbered here).

    // Pre-compute the target sortOrder for every card that will be in this
    // selectorOption after the upsert: incoming richCards (marketplace) PLUS
    // preserved custom cards (existing rows with isCustom=true that are not
    // being overwritten by a new marketplace card with the same cardNumber).
    // Sort by natural cardNumber so custom cards like "9001" land after
    // marketplace cards "1".."335". Done in-memory from data we already
    // hold — re-querying would push past Convex's 4096-read mutation limit
    // on sets with thousands of cross-set custom cards in the table.
    const incomingNumbers = new Set(richCards.map((c) => c.cardNumber));
    const allFinalNumbers: string[] = [
      ...richCards.map((c) => c.cardNumber),
      ...existingCards
        .filter((c) => c.isCustom && !incomingNumbers.has(c.cardNumber))
        .map((c) => c.cardNumber),
    ];
    allFinalNumbers.sort(compareCardNumbers);
    const targetSortOrder = new Map<string, number>();
    allFinalNumbers.forEach((cn, idx) => targetSortOrder.set(cn, idx));

    // NEO-90: cards touched by this commit that have a BSC platform ref
    // but no team resolved yet get queued for the throttled per-card BSC
    // team lookup below (see processBscTeamEnrichmentQueue).
    const bscTeamEnrichmentIds: Array<Id<"cardChecklist">> = [];

    for (let i = 0; i < richCards.length; i++) {
      const card = richCards[i];
      processedNumbers.add(card.cardNumber);
      const newSortOrder = targetSortOrder.get(card.cardNumber) ?? i;
      const existing = existingByNumber.get(card.cardNumber);
      if (existing) {
        const mergedPlatformData = {
          ...existing.platformData,
          ...card.platformData,
        };
        await ctx.db.patch(existing._id, {
          cardName: card.cardName,
          // NEO-26: legacy `team` removed; only teamOnCardIds[] is written.
          playerIds: card.playerIds,
          teamOnCardIds: card.teamOnCardIds,
          attributes: card.attributes,
          isRookie: card.isRookie,
          isRelic: card.isRelic,
          printRun: card.printRun,
          autographType: card.autographType,
          cardVariation: card.cardVariation,
          platformData: mergedPlatformData,
          sourcePlatformIds: card.sourcePlatformIds,
          sortOrder: newSortOrder,
          lastUpdated: Date.now(),
        });
        if (
          mergedPlatformData.bsc &&
          (!card.teamOnCardIds || card.teamOnCardIds.length === 0) &&
          !existing.teamCheckDoneAt
        ) {
          bscTeamEnrichmentIds.push(existing._id);
        }
      } else {
        // NEO-71-74: precedence = the leaf node's complete features snapshot
        // (already resolved at that node's own creation time) < card-observed
        // facts. A fact seen on THIS card (e.g. it's a rookie) beats the
        // inherited values.
        const mergedFeatures: Record<string, string> = {
          ...(inheritedFeaturesOrUndefined ?? {}),
          ...deriveCardObservedFeatures(card),
        };
        // A card arriving already-autographed (marketplace data carried an
        // autographType) gets the same "just became non-None -> default
        // Signed By from the roster" treatment `setCardFeature` applies for
        // a manual operator edit — the roster is already resolved as real
        // IDs at this point (see the player/team findOrCreate pass above).
        const wasBlank =
          (inheritedFeaturesOrUndefined?.autographed ?? "None") === "None";
        const isNowSet =
          !!mergedFeatures.autographed && mergedFeatures.autographed !== "None";

        // Resolved once, unconditionally — used for the signedBy default
        // below (only when autographed just turned on) AND unconditionally
        // for listing-title/description generation further down.
        let playerNames: string[] = [];
        if (card.playerIds && card.playerIds.length > 0) {
          const players = await Promise.all(
            card.playerIds.map((id) => ctx.db.get(id)),
          );
          playerNames = players
            .filter((p): p is NonNullable<typeof p> => p !== null)
            .map((p) => p.name);
        }
        if (wasBlank && isNowSet && !mergedFeatures.signedBy && playerNames.length > 0) {
          mergedFeatures.signedBy = playerNames.join(", ");
        }
        const featuresOrUndefined =
          Object.keys(mergedFeatures).length > 0 ? mergedFeatures : undefined;

        // NEO-24/71-74: write-once listing title/description, generated
        // once here at creation time, then freely editable afterward (same
        // model as every other default this session).
        const listingInputs = {
          cardNumber: card.cardNumber,
          playerNames,
          year: mergedFeatures.season,
          manufacturer: mergedFeatures.manufacturer,
          setName: setNameValue,
          parallelName: mergedFeatures.parallelName,
          isRookie: card.isRookie,
          isRelic: card.isRelic,
          autographed: mergedFeatures.autographed,
          shortPrint: mergedFeatures.shortPrint,
        };

        const newCardId = await ctx.db.insert("cardChecklist", {
          selectorOptionId: args.selectorOptionId,
          cardNumber: card.cardNumber,
          cardName: card.cardName,
          // NEO-26: legacy `team` removed; only teamOnCardIds[] is written.
          playerIds: card.playerIds,
          teamOnCardIds: card.teamOnCardIds,
          attributes: card.attributes,
          isRookie: card.isRookie,
          isRelic: card.isRelic,
          printRun: card.printRun,
          autographType: card.autographType,
          cardVariation: card.cardVariation,
          platformData: card.platformData,
          sourcePlatformIds: card.sourcePlatformIds,
          // NEO-24: inherit ancestor + derive per-card on insert. Existing
          // rows are owned by the propagation engine; never clobbered here.
          ...(featuresOrUndefined ? { features: featuresOrUndefined } : {}),
          listingTitle: generateListingTitle(listingInputs),
          listingDescription: generateListingDescription(listingInputs),
          sortOrder: newSortOrder,
          lastUpdated: Date.now(),
        });
        // NEO-91: SKU can only be generated once the row exists (the random
        // suffix — not the id — is what guarantees uniqueness, but the id
        // has to exist before we can patch it in). Cheap, well-precedented
        // insert-then-patch pattern already used elsewhere in this file.
        await ctx.db.patch(newCardId, {
          sku: generateSku({
            sport: args.sport,
            year: mergedFeatures.season ?? "",
            setName: setNameValue ?? "",
            cardNumber: card.cardNumber,
            uniqueSuffix: crypto.randomUUID(),
          }),
        });
        if (
          card.platformData?.bsc &&
          (!card.teamOnCardIds || card.teamOnCardIds.length === 0)
        ) {
          bscTeamEnrichmentIds.push(newCardId);
        }
      }
    }

    for (const existing of existingCards) {
      if (!processedNumbers.has(existing.cardNumber) && !existing.isCustom) {
        await ctx.db.delete(existing._id);
      }
    }

    // Patch preserved custom cards whose sortOrder shifted because of the
    // marketplace upsert above. No reads here — works from data already
    // loaded into `existingCards`.
    for (const existing of existingCards) {
      if (!existing.isCustom) continue;
      if (incomingNumbers.has(existing.cardNumber)) continue; // not preserved; replaced
      const target = targetSortOrder.get(existing.cardNumber);
      if (target !== undefined && existing.sortOrder !== target) {
        await ctx.db.patch(existing._id, { sortOrder: target });
      }
    }

    // Clear pendingPlayerNames / pendingTeamNames entries on custom cards
    // for names that are now resolved (either pre-existing in players/teams
    // or just created via the confirmed-new lists). Without this, every
    // subsequent fetchCardChecklist would keep re-prompting for the same
    // custom-card player names because they'd stay in pending* forever.
    for (const existing of existingCards) {
      if (!existing.isCustom) continue;
      const patch: {
        pendingPlayerNames?: string[];
        pendingTeamNames?: string[];
      } = {};
      if (existing.pendingPlayerNames && existing.pendingPlayerNames.length > 0) {
        const stillPending = existing.pendingPlayerNames.filter(
          (n) => !playerIdByName.has(n.trim()),
        );
        if (stillPending.length !== existing.pendingPlayerNames.length) {
          patch.pendingPlayerNames =
            stillPending.length > 0 ? stillPending : undefined;
        }
      }
      if (existing.pendingTeamNames && existing.pendingTeamNames.length > 0) {
        const stillPending = existing.pendingTeamNames.filter(
          (n) => !teamIdByName.has(n.trim()),
        );
        if (stillPending.length !== existing.pendingTeamNames.length) {
          patch.pendingTeamNames =
            stillPending.length > 0 ? stillPending : undefined;
        }
      }
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(existing._id, patch);
      }
    }

    // NEO-92: no post-commit Wikidata scheduling needed anymore — every
    // created player/team was already enriched during the review wizard
    // (reviewByKey's `enrichment`, seeded above at insert time). Delete this
    // batch's now-consumed entityReviewQueue rows SYNCHRONOUSLY, in this same
    // transaction — using `reviewRows`, already read above to resolve
    // decisions, so this adds writes only, no extra reads. Deliberately NOT
    // scheduled async (the original design): a scheduled cleanup left a real
    // race — a re-fetch of the same selectorOptionId landing in the gap
    // between this mutation returning and the scheduled delete actually
    // running would find every row already decided and wrongly resume the
    // dead batch (startBatch) instead of starting fresh. Deleting inline
    // closes that window entirely: by the time this mutation returns, the
    // batch's rows are gone, so a subsequent fetch can never observe them.
    if (args.batchId) {
      for (const row of reviewRows) {
        await ctx.db.delete(row._id);
      }
    }

    // NEO-90: same chained-queue shape, for BSC per-card team resolution.
    // Cards whose team wasn't already recoverable from the bulk `players`
    // string (parsePlayersField's TC/parenthetical handling) get resolved
    // one at a time via BSC's per-card detail endpoint in the background.
    if (bscTeamEnrichmentIds.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.adapters.buysportscards.processBscTeamEnrichmentQueue,
        { cardChecklistIds: bscTeamEnrichmentIds },
      );
    }

    // NEO-24/38: harvest the locally-observable card-count from the BSC/SL
    // checklist fetch onto the setName ancestor's `totalCardCount` feature.
    // Only when this commit is itself happening AT the setName level —
    // otherwise this is a variant/insert/parallel fetch and our card count is
    // a subset, not the set total. releaseDate/block are purely manual (no
    // auto-harvest) and live in the same features map, independently editable
    // at every level via setSelectorOptionFeature (see the comment on that
    // mutation above for why these were folded out of the old, setName-only
    // `setMetadata` object).
    if (setNameAncestorId && args.selectorOptionId === setNameAncestorId) {
      const setNameRow = await ctx.db.get(setNameAncestorId);
      if (setNameRow) {
        const newCount = String(richCards.length);
        if (setNameRow.features?.totalCardCount !== newCount) {
          await ctx.db.patch(setNameAncestorId, {
            features: { ...(setNameRow.features ?? {}), totalCardCount: newCount },
            lastUpdated: Date.now(),
          });
        }
      }
    }

    return {
      success: true,
      count: richCards.length,
      createdPlayerIds,
      createdTeamIds,
    };
  },
});
