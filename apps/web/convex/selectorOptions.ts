import {
  query,
  mutation,
  action,
  internalAction,
  internalMutation,
  internalQuery,
  ActionCtx,
  QueryCtx,
} from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { api, internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { getCurrentUserId, requireAdmin } from "./auth";
import {
  recordAdapterCall,
  newRequestId,
  classifyAdapterError,
} from "./observability";
// NEO-198: the per-child deadlines below are derived from the adapters' own
// retry policies rather than hand-written next to them. selectorBudgets.ts is
// deliberately a plain module (no "use node") so both this isolate file and the
// two Node adapters can import the same numbers.
import {
  SL_SELECTOR_BUDGET,
  BSC_SELECTOR_BUDGET,
  CHILD_DEADLINE_MARGIN_MS,
} from "./adapters/selectorBudgets";
import {
  deriveCardObservedFeatures,
  deriveOwnLevelFeatures,
  validateFeatureValue,
} from "./features/deriveCardFeatures";
import {
  assessListingTitle,
  generateListingDescription,
  type ListingCardInputs,
} from "./features/generateListing";
import { LISTING_TITLE_MAX } from "./features/listingLimits";
import { generateSku } from "./sku";
import {
  cardNumberStem,
  resolveVariationParents,
  suggestVariationPairings,
} from "../lib/cards/variations";
import { compareCardNumbers } from "../lib/cards/card-number";
// NEO-212: the SINGLE career-timeline ordering, shared with `enrichPlayer` in
// convex/adapters/wikidata.ts. Both write `players.teamYears`, and a player
// can be created by either, so they must not disagree about the order.
import { sortTeamYears } from "../lib/players/team-tenure";
// NEO-189: bounded retry for Convex's optimistic-concurrency conflict, used
// by every phase of the chunked commit below.
import { runWithOccRetry } from "../lib/errors/occ-retry";
// NEO-199: the SAME comparison CardPairingModal uses on a hand-linked pair.
// An auto-matched disagreement and a manual one have to be the same thing —
// see the note in lib/cards/card-name.ts.
// NEO-203: `nameKey` is the SAME case/whitespace/punctuation/diacritic fold
// the pairing modal already judges "do these two names mean the same thing?"
// with. The content-diff review reuses it verbatim to decide whether a changed
// field is a reformatting or a rewrite — a second fold would mean two screens
// in one pipeline disagreeing about what counts as cosmetic.
import { conflictingNames, nameKey } from "../lib/cards/card-name";
import { sportConfigDefaultsFor } from "./sportConfig";
// NEO-211: the one matcher + the one value-validation path, shared with
// setReconciliation.ts so review, write and suggestion can never disagree.
import {
  PLATFORM_SIDES,
  checkSelectorValue,
  valuesDeepEqual,
  clearDeclinedIfLabelChanged,
  planSelectorSync,
  planValueRename,
  resolveReturnedIds,
  refusesValueRename,
  selectorValueKey,
  unlinkStalePrimary,
  VARIANT_TYPE_RENAME_MESSAGE,
  VARIANT_TYPE_RENAME_REFUSED,
  type IncomingItem,
} from "./selectorSyncMatch";
import {
  MAX_SYNC_ITEMS,
  UNLINK_NOTICE_LIMIT,
  annotateHasCards,
  checkReturnedIds,
  platformSideValidator,
  returnedIdsValidator,
  unionChildren,
  unlinkedEntryValidator,
  type UnlinkedEntry,
} from "./selectorSyncStore";
import { findSportForSelectorOption } from "./cardChecklist";
import { MAX_CARD_TEAMS } from "./features/cardAttention";
import { normalizePlayerName } from "./players";
import { normalizeTeamName } from "./teams";
import { findOrCreateLeague, resolveDefaultLeagueId } from "./leagues";
import {
  cardPlatformDataValidator,
  cardPlatformWireDataValidator,
  selectorOptionFields,
  selectorOptionLevelValidator,
} from "./schema";
import {
  bscFacetValidator,
  resolveBscFacetFilters,
} from "./bscFacets";
import {
  allocateSlots,
  detachSlot,
  idForSlot,
  initialSlots,
  isSlotKeyForSide,
  primaryId,
  primarySlot,
  pruneEmptySides,
  setPrimarySlotId,
  slotEntries,
  slotForId,
  slotIds,
  slotLabel,
} from "./platformSlots";

// The wire still speaks marketplace IDs — clients know nothing about slots.
function wireToIds(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

type WirePlatformData = {
  bsc?: { ref: string; setId?: string };
  sportlots?: { ref: string; setId?: string };
};

type StoredPlatformData = {
  bsc?: { ref: string; src?: string };
  sportlots?: { ref: string; src?: string };
};

/**
 * NEO-137 — resolve incoming cards' WIRE platformData (marketplace set ids)
 * into STORED platformData (slot keys on the card's own parent row).
 *
 * A stored card's `src` always names a slot on its own parent, which is what
 * makes the pointer unambiguous. So any source set a card names that is not
 * yet attached to that parent gets a slot allocated here — the operator's
 * "as long as they are connected at the parent" rule, enforced at write time
 * rather than assumed.
 *
 * A ref with no `setId` (a marketplace that returned no source tag) resolves
 * against the side's PRIMARY slot, which is the only sensible reading: the
 * card came from whichever set this row syncs by default.
 *
 * Returns the per-side lookup plus any row patch needed to record newly
 * allocated slots. The caller applies the patch — the counter and the map it
 * guards must move together.
 */
async function resolveCardSlots(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<Doc<"selectorOptions"> | null> } },
  selectorOptionId: Id<"selectorOptions">,
): Promise<
  (pd: WirePlatformData, existing?: StoredPlatformData) => StoredPlatformData
> {
  const row = await ctx.db.get(selectorOptionId);
  if (!row) return () => ({});

  const slotById: Record<"bsc" | "sportlots", Record<string, string>> = {
    bsc: {},
    sportlots: {},
  };
  for (const side of ["bsc", "sportlots"] as const) {
    for (const { slot, id } of slotEntries(row, side)) slotById[side][id] = slot;
  }
  const primaryBySide = {
    bsc: primarySlot(row, "bsc"),
    sportlots: primarySlot(row, "sportlots"),
  };

  return (
    pd: WirePlatformData,
    existing?: StoredPlatformData,
  ): StoredPlatformData => {
    const out: StoredPlatformData = {};
    for (const side of ["bsc", "sportlots"] as const) {
      const wire = pd?.[side];
      if (!wire) continue;

      let src: string | undefined;
      if (wire.setId) {
        // Resolve ONLY against sets already attached to the parent row.
        //
        // This used to ALLOCATE a slot for any set id a card named, which
        // contradicted the invariant stated on `cardPlatformRefValidator` in
        // schema.ts ("cannot participate in sync-by-set until an operator
        // attaches the set it came from"). The id is not ours: on the BSC side
        // it is `r.setName` straight out of the marketplace's bulk-upload
        // response, so a rename or a display-name/slug divergence would have
        // silently grown this row's mapping — and `fetchCardChecklist` filters
        // its next BSC query on ALL attached slots, so an injected slug would
        // then widen a privileged outbound fetch to an unrelated set.
        //
        // Attaching a marketplace set stays an operator action
        // (AttachSetsDialog / reconciliation), consistent with every other
        // confirmation gate in this feature.
        src = slotById[side][wire.setId];
      } else if (existing?.[side]?.src) {
        // No source tag from the marketplace: keep whatever this card was
        // already attributed to rather than snapping it back to the primary,
        // which would silently repoint a card bound to an operator-attached
        // extra slot.
        src = existing[side]!.src;
      } else {
        src = primaryBySide[side];
      }

      // Keep the ref even when no slot resolves — it is still this card's
      // marketplace identity. It just cannot participate in sync-by-set until
      // an operator attaches the set it came from, and surfaces as
      // unattributed until then.
      out[side] = { ref: wire.ref, ...(src ? { src } : {}) };
    }
    return out;
  };
}

/**
 * NEO-203 — the two marketplace sides a card can be linked to, in the fixed
 * order the matching cascade tries them.
 */
const MATCH_SIDES = ["bsc", "sportlots"] as const;
type MatchSide = (typeof MATCH_SIDES)[number];

/**
 * NEO-203 — the tier-2 match key: `side`, the SLOT the card came from, and its
 * card number.
 *
 * `\0` cannot appear in a slot key or a card number, so the join is
 * unambiguous — `"bsc|src1|2"` and `"bsc|src|1-2"` would not be.
 *
 * Built for stored rows in `commitCardChecklistPrelude` (from
 * `platformData[side].src`) and for incoming cards in `resolveExistingIds`
 * (from the wire `setId`, resolved against the parent's ATTACHED slots by the
 * same rule `resolveCardSlots` writes with). One function so the two sides of
 * the comparison cannot drift apart.
 */
function slotNumberMatchKey(
  side: MatchSide,
  slot: string,
  cardNumber: string,
): string {
  return `${side}\u0000${slot}\u0000${cardNumber}`;
}

/**
 * NEO-203 — bound one identifier before it reaches a log line.
 *
 * A SportLots ref IS the card description (NEO-91), so it is unbounded text
 * that came from a marketplace. Every structured log below reports bounded
 * SAMPLES plus a full count, and truncates each identifier it prints; the
 * count is the operational signal, the sample is only there to make the
 * problem recognisable. Refs never go into a `ConvexError` message at all —
 * that string crosses to the browser.
 */
const LOG_REF_MAX_CHARS = 120;
function truncateForLog(value: string): string {
  return value.length > LOG_REF_MAX_CHARS
    ? `${value.slice(0, LOG_REF_MAX_CHARS)}…`
    : value;
}

/**
 * NEO-203 — the card fields NeonBinder owns, and the ONLY ones a re-sync may
 * write onto an existing row, and then only for the fields the operator named
 * in `applyFields`.
 *
 * Everything not on this list is either linkage (`platformData` — always
 * refreshed, it is the whole reason the sync exists), NB bookkeeping
 * (`sortOrder`, `lastUpdated`, `sku`), or owned by another engine entirely
 * (`features` by propagation, `variationOfCardId` by the finalize pass).
 *
 * Per-FIELD rather than per-card because the two decisions are genuinely
 * independent: an upstream fix that adds a missing rookie flag and an upstream
 * "correction" that overwrites a carefully spelled card name arrive on the
 * same card, and an operator must be able to take the first without the
 * second.
 */
const NB_CONTENT_FIELDS = [
  "cardName",
  "playerIds",
  "teamOnCardIds",
  "attributes",
  "isRookie",
  "isRelic",
  "printRun",
  "autographType",
  "cardVariation",
] as const;
type NbContentField = (typeof NB_CONTENT_FIELDS)[number];
const NB_CONTENT_FIELD_SET: ReadonlySet<string> = new Set(NB_CONTENT_FIELDS);

/**
 * NEO-203 — is the incoming value for one NB content field the same thing the
 * row already says?
 *
 * The chunk re-runs the diff server-side before writing anything, so an
 * accepted field whose value did not actually change is dropped from the
 * patch. This only ever removes writes, never adds one.
 *
 * ## What counts as "says nothing"
 *
 * Five spellings, and on these fields they are all one statement:
 *
 *   `undefined` · `null` · `[]` · `false` · `""`
 *
 * An absent array and an empty one are the same statement ("no players on this
 * card"), and both spellings occur on both sides — the action leaves an empty
 * resolution `undefined`, while an adapter may send `[]`.
 *
 * `false` and `""` were added after CI round 2 caught the real cost of leaving
 * them out. Saving a card in the edit drawer writes EXPLICIT `isRookie: false`,
 * `isRelic: false`, `cardVariation: ""`, while the adapters simply omit those
 * keys on a card that is none of those things. So every card an operator had
 * curated came back on the next re-sync carrying spurious tier-1 "needs review"
 * diffs — `Rookie: − no / + —`, `Variation: − — / + —` — i.e. the review screen
 * shouted loudest about precisely the cards a human had already got right, and
 * one of those entries folded equal, pre-ticked itself, and made the footer
 * claim a change was pending when nothing had changed at all.
 *
 * "Not a rookie" and "no rookie flag recorded" are the same fact about a
 * baseball card; so are "" and "no variation". This is a domain truth, not a
 * comparison convenience — which is why it belongs HERE, in the one predicate
 * both the review diff and the chunk's pre-write re-diff read, rather than as a
 * filter bolted onto the display layer.
 *
 * NOT emptyish: `0`. A number field on these cards (`printRun`) has no zero
 * that means "absent" — `/0` is not a print run — so folding it in would only
 * ever hide a real difference.
 *
 * Arrays compare ELEMENT-WISE IN ORDER. Order is meaningful here: `playerIds`
 * on a multi-player card lists them as the card does, and that ordering feeds
 * the generated listing title.
 */
function sameContentValue(stored: unknown, incoming: unknown): boolean {
  const emptyish = (x: unknown) =>
    x === undefined ||
    x === null ||
    x === false ||
    x === "" ||
    (Array.isArray(x) && x.length === 0);
  if (emptyish(stored) && emptyish(incoming)) return true;
  if (Array.isArray(stored) && Array.isArray(incoming)) {
    return (
      stored.length === incoming.length &&
      stored.every((value, i) => value === incoming[i])
    );
  }
  return stored === incoming;
}

/**
 * NEO-203 — how much a re-sync is trusted to change one field, unreviewed.
 *
 * TIER 1 — trust-critical. These are what a listing is generated FROM and what
 * a buyer sees: who is on the card, which team, whether it is a rookie, a
 * relic, an autograph, numbered, or a named variation. A marketplace
 * "correcting" any of them over an operator's own answer is the failure this
 * ticket exists to prevent, so the review UI never pre-checks a tier-1 change.
 *
 * TIER 2 — `cardName` and `attributes`. Substantive when they change meaning,
 * routine when they change spelling.
 *
 * There is no tier 3 field, because tier 3 is not a field property: it is the
 * CHANGE being a pure case/whitespace/punctuation/diacritic reformatting
 * ("Jose" → "José", "Ken Griffey Jr" → "Ken Griffey Jr."). That is decided per
 * diff entry via `foldEqual`, and a fold-equal change is safe to accept on ANY
 * field including a tier-1 one — the card is still saying the same thing. So
 * the tier here drives PRESENTATION and the formatting-only/content-changes
 * split; `foldEqual` drives the default checkbox state.
 */
const NB_CONTENT_FIELD_TIER: Record<NbContentField, 1 | 2> = {
  cardName: 2,
  attributes: 2,
  playerIds: 1,
  teamOnCardIds: 1,
  isRookie: 1,
  isRelic: 1,
  printRun: 1,
  autographType: 1,
  cardVariation: 1,
};

/**
 * NEO-203 — one content value as the review UI has to render it.
 *
 * Every NB content field ends up a string on the wire because the review is
 * a git-style old/new comparison and the fields are heterogeneous (string
 * arrays, booleans, a number, plain strings). Empty comes back as the empty
 * string, which the UI paints as an em dash — "this card says nothing here" is
 * a real and different statement from "this card says no".
 */
function displayContentValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

// ===== LEVEL VALIDATOR (reused across functions) =====
const levelValidator = selectorOptionLevelValidator;

/**
 * NEO-137 phase 0 — the full `selectorOptions` document as a `returns`
 * validator, built FROM the schema rather than re-listing its fields.
 *
 * Convex validates `returns` strictly, so any query returning whole rows must
 * enumerate every field the row can carry. Four queries here used to do that
 * by hand, and they drifted: `getInsertTreeByVariantType` was missing
 * `platformLabels`, `primaryPlatformId` and `sportConfig`, which threw
 * `Object contains extra field 'primaryPlatformId'` in prod for every
 * reconciled row and broke Group Parallels. `sportConfig` had already caused
 * the same outage once (NEO-96).
 *
 * Deriving from `selectorOptionFields` means a field added to the table is in
 * all four validators automatically. Do NOT re-inline these fields.
 */
const selectorOptionDocValidator = v.object({
  _id: v.id("selectorOptions"),
  _creationTime: v.number(),
  ...selectorOptionFields,
});

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
  returns: v.array(selectorOptionDocValidator),
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
        // NEO-137: both sides read through the same helper. The SL branch
        // used to handle only the `string` case and silently skipped arrays,
        // so an insert mapped to several SL sets did not register any of them
        // as used and could be double-claimed by a sibling variantType.
        slPlatformValues.push(...slotIds(ins, "sportlots"));
        bscPlatformValues.push(...slotIds(ins, "bsc"));
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
      platformData: selectorOptionFields.platformData,
      platformLabels: selectorOptionFields.platformLabels,
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
  returns: v.union(v.null(), selectorOptionDocValidator),
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
  returns: v.union(v.null(), selectorOptionDocValidator),
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

/**
 * NEO-96: the enrichment adapters (Wikidata/ESPN) are actions and cannot read
 * the db, so they resolve a sport row's config through this. Returns the
 * display label for log lines plus whatever config the row carries — all of it
 * optional, because a custom/unmapped sport legitimately has none and callers
 * degrade rather than error.
 *
 * Internal: no auth gate, matching the other internal read helpers here. It is
 * unreachable from a client.
 */
export const getSportEnrichmentContext = internalQuery({
  args: { sportId: v.id("selectorOptions") },
  returns: v.union(
    v.object({
      label: v.string(),
      espn: v.optional(v.object({ path: v.string(), leagueName: v.string() })),
      wikidata: v.optional(
        v.object({
          sportQid: v.string(),
          hallOfFameQid: v.optional(v.string()),
        }),
      ),
    }),
    v.null(),
  ),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.sportId);
    if (!row) return null;
    return {
      label: row.value,
      ...(row.sportConfig?.espn ? { espn: row.sportConfig.espn } : {}),
      ...(row.sportConfig?.wikidata ? { wikidata: row.sportConfig.wikidata } : {}),
    };
  },
});

export const getAncestorChain = query({
  args: { id: v.id("selectorOptions") },
  returns: v.array(
    v.object({
      _id: v.id("selectorOptions"),
      level: levelValidator,
      value: v.string(),
      platformData: selectorOptionFields.platformData,
      platformLabels: selectorOptionFields.platformLabels,
      // NEO-189: without this the checklist fetch cannot tell a BSC setName
      // slug from a variantName slug and falls back to guessing from the NB
      // level — which is the bug. Derived from the schema, not re-listed, so
      // it cannot drift from the table.
      platformFacets: selectorOptionFields.platformFacets,
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
      platformData: {
        bsc?: Record<string, string>;
        sportlots?: Record<string, string>;
      };
      platformLabels?: {
        bsc?: Record<string, string>;
        sportlots?: Record<string, string>;
      };
      platformFacets?: { bsc?: Record<string, "setName" | "variantName"> };
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
        platformLabels: option.platformLabels,
        platformFacets: option.platformFacets,
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

/**
 * NEO-212 — which of these candidate names has an operator already ruled "not
 * a person / not a team" for this set?
 *
 * Lives here rather than in entityReviewQueue.ts because its only caller is
 * `resolveUnknownsAndStartBatch` below, and it is shaped for that caller: one
 * round trip carrying every candidate, rather than the N `ctx.runQuery` hops
 * an action would otherwise pay to ask the same question name by name. Inside,
 * it is still one indexed point lookup per candidate against
 * `by_selector_option_and_kind_and_name` — batches are at most a few hundred
 * names, comfortably inside a query's read budget.
 *
 * Takes NORMALIZED names, because that is what the index stores and what the
 * caller has already computed to dedupe its own candidates. Returns the subset
 * that is skipped, as `${kind}:${nameNormalized}` keys — a flat set the caller
 * can test membership against without rebuilding a per-kind structure.
 */
export const findSkippedEntityNames = internalQuery({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    candidates: v.array(
      v.object({
        kind: v.union(v.literal("player"), v.literal("team")),
        nameNormalized: v.string(),
      }),
    ),
  },
  returns: v.array(v.string()),
  handler: async (ctx, args): Promise<string[]> => {
    const skipped: string[] = [];
    for (const candidate of args.candidates) {
      const row = await ctx.db
        .query("entityReviewSkips")
        .withIndex("by_selector_option_and_kind_and_name", (q) =>
          q
            .eq("selectorOptionId", args.selectorOptionId)
            .eq("kind", candidate.kind)
            .eq("nameNormalized", candidate.nameNormalized),
        )
        .first();
      if (row) skipped.push(`${candidate.kind}:${candidate.nameNormalized}`);
    }
    return skipped;
  },
});

/**
 * Detect unresolved player/team names for a selectorOption and kick off the
 * NEO-92 review-wizard batch for whatever's unresolved. Shared by both the
 * marketplace path (folds in names observed on freshly-reconciled cards via
 * `additionalPlayerNames`/`additionalTeamNames`) and the custom-subtree path
 * (no marketplace cards at all, but its own custom cards can still carry
 * `pendingPlayerNames`/`pendingTeamNames` that need the exact same
 * resolution flow — every custom card on this selectorOption is read here
 * regardless of path, via `getCardChecklist`).
 *
 * Before this was extracted, the custom-subtree branch in fetchCardChecklist
 * short-circuited entirely before reaching any of this — a genuine product
 * gap, not just a marketplace-adapter concern: a custom-only set's pending
 * player names could NEVER be resolved via the review wizard, since this was
 * the only place unknowns were ever computed. Splitting it out lets the
 * custom-subtree branch call it too, without touching any BSC/SL logic.
 */
async function resolveUnknownsAndStartBatch(
  ctx: ActionCtx,
  args: {
    selectorOptionId: Id<"selectorOptions">;
    sportId: Id<"selectorOptions">;
    /** Display label, for log/telemetry only. */
    sportLabel: string;
    additionalPlayerNames?: string[];
    additionalTeamNames?: string[];
  },
): Promise<{
  unknownPlayers: string[];
  unknownTeams: string[];
  batchId?: string;
}> {
  const unknownPlayers: string[] = [];
  const unknownTeams: string[] = [];
  let batchId: string | undefined;

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

  for (const p of args.additionalPlayerNames ?? []) addPlayer(p);
  for (const t of args.additionalTeamNames ?? []) addTeam(t);

  // Custom cards (added via addCustomCard) can declare pending player /
  // team names that should also be surfaced as unknown until the user
  // confirms them via the wizard. Without this pass, users who add a
  // custom card for a brand-new player would never get prompted to
  // enrich that player via the standard confirmation flow.
  const customRows = await ctx.runQuery(api.selectorOptions.getCardChecklist, {
    selectorOptionId: args.selectorOptionId,
  });
  for (const r of customRows) {
    for (const p of r.pendingPlayerNames ?? []) addPlayer(p);
    for (const t of r.pendingTeamNames ?? []) addTeam(t);
  }

  // ── NEO-212: names an operator already ruled are not an entity ──────────
  //
  // THIS is why a skipped name never re-enters the wizard. Everything else
  // about a skip is per-batch and transient — `entityReviewQueue` rows are
  // deleted the moment the commit finishes — so without this read the same
  // "CHECKLIST" header row, sponsor logo, or stray column heading would be
  // handed back to the operator on every single re-fetch of the set, and the
  // only way to clear the wizard would remain what it was before: creating a
  // bogus player row for it.
  //
  // Dropped BEFORE the players/teams existence checks, not after, so a skipped
  // name is not merely left out of the batch but never counted as "unknown" at
  // all — the caller reports these counts to the operator, and a name they
  // have already settled is not an open question. It also saves the lookup.
  //
  // Scoped to THIS selectorOption, matching the table's per-set key: a name
  // that is noise on one checklist is very often a real player on the next.
  const skippedKeys = new Set(
    await ctx.runQuery(internal.selectorOptions.findSkippedEntityNames, {
      selectorOptionId: args.selectorOptionId,
      candidates: [
        ...Array.from(playerByNorm.keys(), (nameNormalized) => ({
          kind: "player" as const,
          nameNormalized,
        })),
        ...Array.from(teamByNorm.keys(), (nameNormalized) => ({
          kind: "team" as const,
          nameNormalized,
        })),
      ],
    }),
  );

  for (const [normalized, name] of playerByNorm) {
    if (skippedKeys.has(`player:${normalized}`)) continue;
    const existing = await ctx.runQuery(api.players.findByNameAndSport, {
      name,
      sportId: args.sportId,
    });
    if (!existing) unknownPlayers.push(name);
  }
  for (const [normalized, name] of teamByNorm) {
    if (skippedKeys.has(`team:${normalized}`)) continue;
    const existing = await ctx.runQuery(api.teams.findByNameAndSport, {
      name,
      sportId: args.sportId,
    });
    if (!existing) unknownTeams.push(name);
  }

  // NEO-92: kick off the review-wizard batch (background Wikidata preview
  // lookups + resumable decision queue) for whatever's unresolved.
  // startBatch resumes an in-progress batch for this (selectorOptionId,
  // user) pair rather than restarting it, so re-clicking "Fetch from
  // Marketplaces" mid-review never discards progress — and is scoped
  // per-user so two different sessions fetching the SAME set never
  // share/collide on one batch.
  if (unknownPlayers.length > 0 || unknownTeams.length > 0) {
    const callerId = await getCurrentUserId(ctx);
    if (!callerId) throw new Error("Not authenticated");
    batchId = await ctx.runMutation(internal.entityReviewQueue.startBatch, {
      selectorOptionId: args.selectorOptionId,
      createdByUserId: callerId,
      sportId: args.sportId,
      playerNames: unknownPlayers,
      teamNames: unknownTeams,
    });
  }

  return { unknownPlayers, unknownTeams, batchId };
}

/**
 * Human-readable label for a set node ("2021 Score Football"), built from its
 * own parent chain. NEO-21 needs it on both sides of a cross-listing — the
 * guest checklist labels each visiting card's home set, the card detail lists
 * every guest set it appears in. Kept next to its two callers rather than
 * generalized, same as `findSetNameValue`.
 */
async function buildSetLabel(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<any> } },
  selectorOptionId: Id<"selectorOptions">,
): Promise<string> {
  const byLevel = new Map<string, string>();
  let cursorId: Id<"selectorOptions"> | undefined = selectorOptionId;
  while (cursorId) {
    const node = await ctx.db.get(cursorId);
    if (!node) break;
    byLevel.set(node.level, node.value);
    cursorId = node.parentId;
  }
  return ["year", "manufacturer", "setName"]
    .map((level) => byLevel.get(level))
    .filter((value): value is string => !!value)
    .join(" ");
}

/**
 * One row of a rendered checklist: a card, plus the guest-side annotations set
 * only when it's visiting from another product.
 *
 * Declared as ONE type covering both cases on purpose. The handler builds the
 * result as `[...homeCards, ...guestCards]`, and without this the inferred
 * element type is a union — home rows lack the three fields entirely, so
 * `card.isCrossListed` is a type error for every *consumer* of this query even
 * though the returns validator allows it. The client type is inferred from the
 * handler's return, not from the validator.
 */
type CardChecklistRow = Doc<"cardChecklist"> & {
  isCrossListed?: boolean;
  crossListingId?: Id<"cardCrossListings">;
  homeSetLabel?: string;
};

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
      // NEO-102: the two halves of "does this card still need a human to
      // settle its team?". Returned because the checklist derives that badge
      // client-side through `features/cardAttention.ts` — the same pure
      // function a server-side caller would use — and `teamCheckDoneAt` above
      // is only half the answer.
      teamNoneConfirmedAt: v.optional(v.number()),
      // Audit only; the UI reads nothing from it. It is here because Convex
      // validates `returns` STRICTLY — see the note on `variationOfCardId`
      // below — so a field the table carries and this list omits throws
      // `Object contains extra field` for every row that has it. This query is
      // `requireAdmin`, and the value is an admin's own Clerk subject.
      teamNoneConfirmedByUserId: v.optional(v.string()),
      attributes: v.optional(v.array(v.string())),
      isRookie: v.optional(v.boolean()),
      isRelic: v.optional(v.boolean()),
      printRun: v.optional(v.number()),
      autographType: v.optional(v.string()),
      cardVariation: v.optional(v.string()),
      // NEO-189: the card this one is a variation OF. Convex validates
      // `returns` STRICTLY, so omitting a field the table carries throws
      // `Object contains extra field` at runtime for every row that has it —
      // the exact failure `selectorOptionFields` exists to prevent one table
      // over.
      variationOfCardId: v.optional(v.id("cardChecklist")),
      variationParentManual: v.optional(v.boolean()),
      // NEO-25: marketplace-agnostic listing strings (see schema.ts).
      listingTitle: v.optional(v.string()),
      listingDescription: v.optional(v.string()),
      // NEO-101: the generated title's core was cut to fit at creation time
      // (see schema.ts). Returned because the checklist derives the
      // `titleTruncated` attention item client-side through
      // `features/cardAttention.ts`, and unlike `titleOverLimit` this one
      // cannot be measured off the title string.
      listingTitleTruncated: v.optional(v.boolean()),
      imageUrls: v.optional(v.object({
        front: v.optional(v.string()),
        back: v.optional(v.string()),
      })),
      platformData: cardPlatformDataValidator,
      isCustom: v.optional(v.boolean()),
      pendingPlayerNames: v.optional(v.array(v.string())),
      pendingTeamNames: v.optional(v.array(v.string())),
      features: featuresValidator,
      // NEO-91: cross-marketplace SKU (see convex/sku.ts).
      sku: v.optional(v.string()),
      sortOrder: v.number(),
      lastUpdated: v.number(),
      // NEO-21: set only on guest rows — cards printed in another product
      // that also complete this checklist. `selectorOptionId` still points at
      // the home set, so the UI needs the label to say where it came from.
      isCrossListed: v.optional(v.boolean()),
      crossListingId: v.optional(v.id("cardCrossListings")),
      homeSetLabel: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const homeCards = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();

    const crossListings = await ctx.db
      .query("cardCrossListings")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();

    // Guest cards typically all come from the same home set, so cache the
    // label per home node instead of re-walking the chain for each card.
    const labelCache = new Map<string, string>();
    const guestCards: CardChecklistRow[] = [];
    for (const link of crossListings) {
      const card = await ctx.db.get(link.cardChecklistId);
      if (!card) continue;
      let homeSetLabel = labelCache.get(card.selectorOptionId);
      if (homeSetLabel === undefined) {
        homeSetLabel = await buildSetLabel(ctx, card.selectorOptionId);
        labelCache.set(card.selectorOptionId, homeSetLabel);
      }
      guestCards.push({
        ...card,
        isCrossListed: true,
        crossListingId: link._id,
        homeSetLabel,
      });
    }

    // A guest row's `sortOrder` was stamped against its home checklist and
    // means nothing here, so order the merged list by card number instead.
    const merged: CardChecklistRow[] = [...homeCards, ...guestCards];
    return merged.sort((a, b) =>
      compareCardNumbers(a.cardNumber, b.cardNumber),
    );
  },
});

// ===== MUTATIONS =====

/**
 * NEO-211 — additive, id-keyed sync for the aggregator levels.
 *
 * WHAT CHANGED, and why it is the whole ticket: this mutation used to end with
 * a delete pass that removed every non-custom row the marketplace did not name
 * in THIS call. Combined with matching purely on display value, that made an
 * operator rename equivalent to "delete this set and everything under it, then
 * insert an empty replacement" — the row's `_id` is what `cardChecklist`,
 * child rows, `cardCrossListings`, `players.sportId` and `teams.sportId` all
 * point at, and nothing re-parents. A single marketplace outage did the same
 * thing to every row linked only to the side that failed.
 *
 * Now: rows are matched by marketplace ID first and name second, nothing is
 * ever deleted, and a marketplace link is removed only when the caller
 * explicitly says that side was fetched successfully (`coveredSides`) and the
 * fetch did not return the id. Every removal is reported back so an admin sees
 * it instead of discovering it later.
 */
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
    /**
     * The sides this call fetched SUCCESSFULLY. Absent = "I am not telling
     * you", which means nothing is unlinked.
     *
     * A Convex deploy is a hard cutover and old SPA bundles stay live for
     * minutes afterwards. An old bundle has no way to say "SportLots was
     * down", so silence has to mean silence — inferring coverage from the
     * items would let that bundle strip SL linkage off every row it touched
     * during an outage. Coverage is then narrowed further to sides that
     * actually carry an id in this batch (see `effectiveCoveredSides`).
     */
    coveredSides: v.optional(v.array(platformSideValidator)),
    /**
     * NEO-211 F1 — the ids the FETCH returned, per side. On the reconciler
     * path this is NOT the same list as `options`; see the validator's note.
     * Absent → derived from the options, which is correct for the aggregator
     * path (there the options ARE the fetch) and for old SPA bundles.
     */
    returnedIds: v.optional(returnedIdsValidator),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    optionsCount: v.number(),
    /** Rows whose marketplace link was removed (NEO-211 D). Capped; see total. */
    unlinked: v.array(unlinkedEntryValidator),
    unlinkedTotal: v.number(),
    /**
     * Rows whose primary id on a side was REPLACED by a different one for the
     * same set — a marketplace re-slug healed by the name tier. Not a loss (the
     * slot key is reused, so every card on it keeps resolving), but it is a
     * silent rebinding of every card under that row, so it is reported.
     */
    relinked: v.array(unlinkedEntryValidator),
    relinkedTotal: v.number(),
     /**
     * Sides whose `returnedIds` list was over the cap and so were treated as
     * NOT covered this run: everything was still stored additively, but
     * nothing was unlinked on them. Empty on every normal sync.
     */
    returnedIdsTruncatedSides: v.array(platformSideValidator),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const { level, options, parentId } = args;

    if (options.length > MAX_SYNC_ITEMS) {
      throw new Error(
        `storeSelectorOptions: ${options.length} options exceeds the ` +
          `${MAX_SYNC_ITEMS}-per-call limit`,
      );
    }

    // NEO-71-74: every option in this batch shares one parentId — fetch its
    // already-complete `features` snapshot once and copy it onto every
    // fresh insert below (write-once feature snapshots: see
    // deriveOwnLevelFeatures in convex/features/deriveCardFeatures.ts).
    const parentFeatures: Record<string, string> | undefined = parentId
      ? (await ctx.db.get(parentId))?.features
      : undefined;

    // The sibling snapshot. This is the ONLY set of rows this call may touch —
    // tier 0's client-supplied ids are resolved against it rather than through
    // ctx.db.get, so a caller cannot steer a write at a row under a different
    // parent or level.
    const existingOptions = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", level).eq("parentId", parentId),
      )
      .collect();

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
      bscId: string | undefined,
    ) => {
      if (!BSC_REQUIRED_LEVELS.has(level)) return;
      if (bscId) return;
      console.warn(
        `[storeSelectorOptions] row missing BSC platform slug — level=${level} ` +
          `value=${value} id=${rowId}. Downstream BSC fetches will hit the ` +
          `missing-slug precondition.`,
      );
    };

    // The wire still speaks marketplace IDs. These upper levels
    // (sport/year/manufacturer/setName) carry exactly one per side.
    const items: IncomingItem[] = options.map((option) => {
      const bsc = wireToIds(option.platformData.bsc)[0];
      const sportlots = wireToIds(option.platformData.sportlots)[0];
      return {
        value: option.value,
        ids: {
          ...(bsc ? { bsc } : {}),
          ...(sportlots ? { sportlots } : {}),
        },
      };
    });

    // NEO-211 — a `returnedIds` side over the cap DEGRADES, it does not throw.
    // The old throw took down a real sync: SportLots lists 2,563 sets for one
    // year, the form passed them all, and "Save 76 sets" never completed. The
    // bound only ever guarded the UNLINK pass, so an oversized list costs an
    // unlink notice for this run — not the operator's saved work. The side
    // falls back to the items for staleness (the pre-`returnedIds` behaviour)
    // and is dropped from coverage, so nothing is unlinked on it.
    const { truncatedSides } = checkReturnedIds(args.returnedIds, "storeSelectorOptions");
    const itemUniverse = resolveReturnedIds(items, undefined);
    const effectiveReturnedIds = args.returnedIds
      ? {
          bsc: truncatedSides.includes("bsc")
            ? [...itemUniverse.bsc]
            : (args.returnedIds.bsc ?? []),
          sportlots: truncatedSides.includes("sportlots")
            ? [...itemUniverse.sportlots]
            : (args.returnedIds.sportlots ?? []),
        }
      : undefined;
    const effectiveCovered = (args.coveredSides ?? []).filter(
      (side) => !truncatedSides.includes(side),
    );

    const plan = planSelectorSync({
      existing: existingOptions,
      items,
      coveredSides: effectiveCovered,
      returnedIds: effectiveReturnedIds,
    });
    if (plan.ambiguities.length > 0) {
      // Deliberately log-only: an ambiguity names sibling rows and is exactly
      // the backend detail NEO-47 keeps out of reactive state.
      console.warn(
        `[storeSelectorOptions] withheld ${plan.ambiguities.length} item(s) ` +
          `at level=${level}: ` +
          JSON.stringify(plan.ambiguities.slice(0, 10)),
      );
    }

    // Working copies of the slot maps, one per row we touch. Built up across
    // the match pass and the unlink pass, then diffed against what is stored
    // so the NEO-85 write-if-changed guard still holds for both.
    type Working = {
      row: (typeof existingOptions)[number];
      platformData: (typeof existingOptions)[number]["platformData"];
      platformLabels: (typeof existingOptions)[number]["platformLabels"];
      platformFacets: (typeof existingOptions)[number]["platformFacets"];
      platformSlotSeq: (typeof existingOptions)[number]["platformSlotSeq"];
      primaryPlatformId: (typeof existingOptions)[number]["primaryPlatformId"];
      declinedUpstreamLabels: (typeof existingOptions)[number]["declinedUpstreamLabels"];
      sportConfig?: (typeof existingOptions)[number]["sportConfig"];
    };
    const byRowId = new Map<string, (typeof existingOptions)[number]>();
    for (const row of existingOptions) byRowId.set(row._id, row);
    const working = new Map<string, Working>();
    const workingFor = (row: (typeof existingOptions)[number]): Working => {
      let w = working.get(row._id);
      if (!w) {
        w = {
          row,
          platformData: row.platformData,
          platformLabels: row.platformLabels,
          platformFacets: row.platformFacets,
          platformSlotSeq: row.platformSlotSeq,
          primaryPlatformId: row.primaryPlatformId,
          declinedUpstreamLabels: row.declinedUpstreamLabels,
        };
        working.set(row._id, w);
      }
      return w;
    };

    const linkedIds: Id<"selectorOptions">[] = [];
    const relinkedAll: UnlinkedEntry[] = [];

    for (let i = 0; i < options.length; i++) {
      const option = options[i];
      const item = items[i];
      const outcome = plan.outcomes[i];
      if (outcome.kind === "withheld") continue;

      if (outcome.kind === "matched") {
        const row = byRowId.get(outcome.existingId)!;
        const w = workingFor(row);
        // NEO-137: refresh the PRIMARY SLOT's id per side rather than merging
        // raw ids. Reusing the slot key is what keeps this row's cards
        // resolving when a marketplace re-slugs a set — the id changes, the
        // set does not. A side with no incoming id is not touched here; it is
        // handled by the unlink pass, which only fires on a covered side.
        for (const side of PLATFORM_SIDES) {
          const incoming = item.ids[side];
          if (!incoming) continue;
          // A name-tier match that lands on a DIFFERENT id than the row held
          // is the re-slug heal. The slot key is reused, so nothing orphans —
          // but every card under this row is now attributed to a different
          // marketplace set, and that must not be silent.
          const previousId = primaryId(w, side);
          if (
            outcome.tier === 2 &&
            previousId !== undefined &&
            previousId !== incoming
          ) {
            relinkedAll.push({ id: row._id, value: row.value, side });
          }
          // At these levels the item's display value IS the marketplace's own
          // name for the set, so it is the label. Storing it is what lets
          // `getSelectorSyncSuggestions` say "BSC calls this Topps" without a
          // second fetch. Skip anything that would not survive validation
          // rather than throwing the whole sync away over one bad name.
          const labelCheck = checkSelectorValue(option.value);
          const label = labelCheck.ok ? labelCheck.value : undefined;
          const next = setPrimarySlotId(w, side, incoming, label);
          w.platformData = next.platformData;
          w.platformLabels = next.platformLabels;
          w.platformFacets = next.platformFacets;
          w.platformSlotSeq = next.platformSlotSeq;
          // A decline is a decision about ONE label. If the marketplace now
          // calls the set something else, the operator has not seen it yet.
          const cleared = clearDeclinedIfLabelChanged(
            w.declinedUpstreamLabels,
            side,
            label,
          );
          if (cleared.changed) w.declinedUpstreamLabels = cleared.next;
        }

        warnIfIncomplete(
          row._id,
          option.value,
          slotIds({ platformData: w.platformData }, "bsc")[0],
        );

        // NEO-96: backfill sportConfig onto a sport row that predates it (or
        // whose earlier sync ran before defaults existed). Only ever ADDS —
        // never overwrites a config already on the row, so an operator edit
        // survives every subsequent sync.
        if (level === "sport" && !row.sportConfig) {
          const backfill = sportConfigDefaultsFor(option.value);
          if (backfill) w.sportConfig = backfill;
        }

        linkedIds.push(row._id);
        continue;
      }

      // No match at any tier → insert. Unchanged from before, except that the
      // marketplace's own name is now recorded as the slot label — and that
      // the value is VALIDATED first (NEO-211 F4). Every other path that
      // writes `value` has been through `checkSelectorValue` since NEO-211;
      // insert was the one door still taking a marketplace string unchecked,
      // so an upstream name carrying a newline or 4 KB of markup would become
      // a row name no rename could later fix.
      const valueCheck = checkSelectorValue(option.value);
      if (!valueCheck.ok) {
        console.warn(
          `[storeSelectorOptions] skipped an unnameable option at ` +
            `level=${level}: ${valueCheck.reason}`,
        );
        continue;
      }
      const insertValue = valueCheck.value;
      const incomingBsc = item.ids.bsc;
      const incomingSl = item.ids.sportlots;
      warnIfIncomplete("new", insertValue, incomingBsc);
      const features = {
        ...(parentFeatures ?? {}),
        ...deriveOwnLevelFeatures(level, insertValue),
      };
      // NEO-96: a sport row carries its own config from creation, so nothing
      // downstream ever looks up SKU codes / QIDs / ESPN paths by display
      // name again. Absent for an unmapped sport — callers degrade, see
      // convex/sportConfig.ts.
      const sportConfig =
        level === "sport" ? sportConfigDefaultsFor(insertValue) : undefined;
      const label = insertValue;
      const alloc = initialSlots({
        ...(incomingBsc ? { bsc: [{ id: incomingBsc, label }] } : {}),
        ...(incomingSl ? { sportlots: [{ id: incomingSl, label }] } : {}),
      });
      const hasLabels =
        Object.keys(alloc.platformLabels.bsc ?? {}).length > 0 ||
        Object.keys(alloc.platformLabels.sportlots ?? {}).length > 0;
      const id = await ctx.db.insert("selectorOptions", {
        level,
        value: insertValue,
        platformData: alloc.platformData,
        ...(hasLabels ? { platformLabels: alloc.platformLabels } : {}),
        ...(Object.keys(alloc.platformSlotSeq).length > 0
          ? { platformSlotSeq: alloc.platformSlotSeq }
          : {}),
        parentId,
        children: [],
        ...(Object.keys(features).length > 0 ? { features } : {}),
        ...(sportConfig ? { sportConfig } : {}),
        lastUpdated: Date.now(),
      });
      linkedIds.push(id);
    }

    // ── Unlink pass (NEO-211 D) ───────────────────────────────────────────
    //
    // A side that was fetched successfully and did not return an id it used to
    // return is upstream saying "this set is not ours any more". The NB row,
    // its name, its children and its cards are untouched; only the marketplace
    // pointer goes. Nothing is persisted to remember the event (Jason,
    // 2026-09-03) — the admin is told, and the row heals itself if the set
    // comes back under a new id, because tier 2 will re-attach it by name.
    //
    // Inside the `options.length > 0` guard the delete pass used to carry: an
    // empty sync is not evidence of anything.
    const unlinkedAll: UnlinkedEntry[] = [];
    if (options.length > 0) {
      for (const side of plan.coveredSides) {
        for (const row of existingOptions) {
          // Custom rows have no upstream that could have dropped them.
          if (row.isCustom) continue;
          const w = workingFor(row);
          const un = unlinkStalePrimary(w, side, plan.returnedIds[side]);
          if (!un) continue;
          w.platformData = un.platformData;
          w.platformLabels = un.platformLabels;
          w.platformFacets = un.platformFacets;
          w.primaryPlatformId = un.primaryPlatformId;
          unlinkedAll.push({ id: row._id, value: row.value, side });
        }
      }
    }

    // ── Write pass ────────────────────────────────────────────────────────
    //
    // NEO-85: only patch when something actually differs from what's stored. A
    // no-op patch still invalidates every query that read this row,
    // re-rendering + reflowing the SetSelector columns for nothing (forensics:
    // `items-changed sameContent=true`). `lastUpdated` is a "data last
    // changed" marker — never displayed or used for staleness (the FE "Last
    // synced" reads cardChecklist.lastUpdated) — so skipping the bump on an
    // unchanged sync is correct. The unlink pass writes through the same
    // guard, so re-running an identical sync reports nothing and patches
    // nothing.
    for (const w of working.values()) {
      const mergedPlatformData = pruneEmptySides({ ...w.platformData });
      const mergedLabels = pruneEmptySides({ ...(w.platformLabels ?? {}) });
      const mergedFacets = pruneEmptySides({ ...(w.platformFacets ?? {}) });
      const nextLabels =
        Object.keys(mergedLabels).length > 0 ? mergedLabels : undefined;
      const nextFacets =
        Object.keys(mergedFacets).length > 0 ? mergedFacets : undefined;

      const patch: Record<string, unknown> = {};
      if (!valuesDeepEqual(mergedPlatformData, w.row.platformData)) {
        patch.platformData = mergedPlatformData;
      }
      if (!valuesDeepEqual(nextLabels ?? null, w.row.platformLabels ?? null)) {
        patch.platformLabels = nextLabels;
      }
      if (!valuesDeepEqual(nextFacets ?? null, w.row.platformFacets ?? null)) {
        patch.platformFacets = nextFacets;
      }
      if (
        !valuesDeepEqual(
          w.platformSlotSeq ?? {},
          w.row.platformSlotSeq ?? {},
        )
      ) {
        patch.platformSlotSeq = w.platformSlotSeq;
      }
      if (
        !valuesDeepEqual(
          w.primaryPlatformId ?? null,
          w.row.primaryPlatformId ?? null,
        )
      ) {
        patch.primaryPlatformId = w.primaryPlatformId;
      }
      if (
        !valuesDeepEqual(
          w.declinedUpstreamLabels ?? null,
          w.row.declinedUpstreamLabels ?? null,
        )
      ) {
        patch.declinedUpstreamLabels = w.declinedUpstreamLabels;
      }
      if (w.sportConfig) patch.sportConfig = w.sportConfig;

      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(w.row._id, { ...patch, lastUpdated: Date.now() });
      }
    }

    // `children` is a set-UNION now (NEO-211 A.7): it never loses a child, so
    // a row the sync did not name keeps its place in the parent's cache.
    if (parentId && linkedIds.length > 0) {
      const parent = await ctx.db.get(parentId);
      if (parent) {
        const next = unionChildren(parent.children, [
          ...linkedIds,
          ...existingOptions.map((o) => o._id),
        ]);
        if (!valuesDeepEqual(parent.children ?? [], next)) {
          await ctx.db.patch(parentId, { children: next });
        }
      }
    }

    const unlinked = await annotateHasCards(
      ctx,
      level,
      unlinkedAll.slice(0, UNLINK_NOTICE_LIMIT),
    );
    if (relinkedAll.length > 0) {
      console.log(
        JSON.stringify({
          msg: "selector_sync_relinked",
          level,
          parentId: parentId ?? null,
          count: relinkedAll.length,
          rowIds: relinkedAll.slice(0, 25).map((r) => r.id),
        }),
      );
    }

    return {
      success: true,
      message: `Successfully stored ${linkedIds.length} ${level} options`,
      optionsCount: linkedIds.length,
      unlinked,
      unlinkedTotal: unlinkedAll.length,
      relinked: relinkedAll.slice(0, UNLINK_NOTICE_LIMIT),
      relinkedTotal: relinkedAll.length,
      returnedIdsTruncatedSides: truncatedSides,
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

// NEO-137 (security review): the card-write paths fan out into a single parent
// `selectorOptions` doc and are read back by four public queries. A batch large
// enough to approach Convex's 1 MB document limit would wedge every subsequent
// write to that row. The largest real checklist in the catalog is ~300 cards
// (2024 Topps Chrome Gold Wave Refractors), so this is far above any genuine
// use while still bounding the blast radius.
const MAX_CARDS_PER_COMMIT = 5000;

function assertCardBatchWithinLimits(cards: unknown[], fnName: string): void {
  if (cards.length > MAX_CARDS_PER_COMMIT) {
    throw new Error(
      `${fnName}: ${cards.length} cards exceeds the ${MAX_CARDS_PER_COMMIT}-card limit for a single call`,
    );
  }
}
//
// A canonical NeonBinder variant (variantType / insert / parallel row) can
// map to multiple BSC and/or SL set IDs. The reconciliation primary is
// recorded in `primaryPlatformId`; operator-attached extras live alongside
// it in `platformData.<side>` (as an array) with human-readable labels in
// `platformLabels.<side>`. The mutations below are the only path operators
// use to attach / detach / rename extras — they patch a single row, and
// they refuse to touch the primary (which is owned by reconciliation).

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
        v.array(
          v.object({
            id: v.string(),
            label: v.string(),
            // NEO-189 — which BSC facet this slug is a value of.
            //
            // OPTIONAL, and absent means "store no tag", never "guess". A BSC
            // slug is not self-describing, so an attach that does not say
            // which facet it belongs to gets the pre-NEO-189 behaviour: the
            // checklist fetch derives the facet from the row's NB level, which
            // for a Base or Parallel row means the id sources nothing. That is
            // exactly what an older client's attach did, so an older client
            // keeps working identically instead of silently creating a slot
            // tagged with a facet it never chose.
            facet: v.optional(bscFacetValidator),
          }),
        ),
      ),
      sportlots: v.optional(
        // No facet: SportLots has one unit of attachment (a set id), so there
        // is nothing to disambiguate.
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

    // Cap check runs before allocation so a batch that would overflow fails
    // atomically rather than attaching a prefix of itself.
    for (const side of ["bsc", "sportlots"] as const) {
      const additions = args.additions[side] ?? [];
      if (additions.length === 0) continue;
      const alreadyAttached = new Set(slotIds(row, side));
      const genuinelyNew = additions.filter(
        ({ id }) => id && !alreadyAttached.has(id),
      ).length;
      if (alreadyAttached.size + genuinelyNew > MAX_ATTACHED_PER_SIDE) {
        throw new Error(
          `attachPlatformIds: cap of ${MAX_ATTACHED_PER_SIDE} attached IDs per side reached (side=${side})`,
        );
      }
    }

    // NEO-137: each genuinely-new ID gets a fresh slot from the row's
    // never-rewound counter. Re-attaching an ID already present is a no-op for
    // platformData but still refreshes its label — an operator re-attaching
    // with a cleaner name expects it to stick.
    //
    // Nothing here checks whether another row already holds the same
    // marketplace ID, deliberately: two sibling rows pointing at one
    // marketplace set is exactly the M:1 mapping this ticket adds.
    const alloc = allocateSlots(row, {
      bsc: (args.additions.bsc ?? [])
        .filter(({ id }) => id)
        .map(({ id, label, facet }) => ({
          id,
          label: label.trim(),
          ...(facet ? { facet } : {}),
        })),
      sportlots: (args.additions.sportlots ?? [])
        .filter(({ id }) => id)
        .map(({ id, label }) => ({ id, label: label.trim() })),
    });
    const mergedPD = alloc.platformData;
    const mergedLabels = alloc.platformLabels;
    const mergedFacets = pruneEmptySides({ ...alloc.platformFacets });
    const attached = alloc.attachedCount;

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
      platformFacets:
        Object.keys(mergedFacets).length > 0 ? mergedFacets : undefined,
      // The counter moves in the SAME patch as the map it guards. Splitting
      // them would let a crash in between hand the next allocation a slot key
      // that is already in use.
      platformSlotSeq:
        Object.keys(alloc.platformSlotSeq).length > 0
          ? alloc.platformSlotSeq
          : undefined,
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
 * Detach a single platform ID. Refuses to detach the reconciliation primary
 * unless the caller passes `confirmPrimary: true` — the operator UI shows an
 * explicit inline confirm step before doing so (NEO-71-74: a bad
 * reconciliation match, e.g. a set that doesn't actually exist on the
 * marketplace, previously had no removal path at all once it landed as
 * primary). Removes the associated label entry as well.
 *
 * When the primary is detached with confirmation, `primaryPlatformId[side]`
 * is explicitly cleared so the `?? current[0]` fallback used everywhere else
 * in this file and in setReconciliation.ts correctly recomputes the new
 * effective primary from whatever remains (or empty, if nothing remains).
 * Known limitation: `storeReconciledOptions`'s refresh-without-clobber path
 * has no memory of a rejected id, so if this exact row's Sync button is
 * clicked again later, the reconciler could re-derive and reinstate the
 * same rejected id as primary. Accepted tradeoff — see NEO-71-74 plan notes.
 */
export const detachPlatformId = mutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    side: platformSideValidator,
    // NEO-137: the SLOT key, not the marketplace ID. A marketplace ID is no
    // longer a unique handle on a row — the same set can legitimately occupy
    // more than one slot, and "detach that set" would be ambiguous. The slot
    // is exactly what the UI renders a row per.
    slot: v.string(),
    confirmPrimary: v.optional(v.boolean()),
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
    if (!isSlotKeyForSide(args.side, args.slot)) {
      throw new Error(
        `detachPlatformId: "${args.slot}" is not a valid ${args.side} slot key`,
      );
    }
    const attachedId = idForSlot(row, args.side, args.slot);
    if (attachedId === undefined) {
      return { success: true, message: "Nothing to detach (slot not attached)" };
    }
    const isPrimary = args.slot === primarySlot(row, args.side);
    if (isPrimary && !args.confirmPrimary) {
      throw new Error(
        `Refusing to detach the reconciliation primary (${args.side}=${attachedId}). ` +
          `Pass confirmPrimary to detach it anyway, or re-run set reconciliation to change the primary.`,
      );
    }

    const detached = detachSlot(row, args.side, args.slot);
    const labelsPatch = pruneEmptySides({ ...detached.platformLabels });
    // NEO-189: the facet tag is slot-scoped, so it goes with the slot.
    const facetsPatch = pruneEmptySides({ ...detached.platformFacets });

    let primaryPatch: { bsc?: string; sportlots?: string } | undefined;
    if (isPrimary) {
      primaryPatch = { ...(row.primaryPlatformId ?? {}) };
      delete primaryPatch[args.side];
      if (Object.keys(primaryPatch).length === 0) primaryPatch = undefined;
    }

    await ctx.db.patch(row._id, {
      platformData: pruneEmptySides({ ...detached.platformData }),
      platformLabels:
        Object.keys(labelsPatch).length > 0 ? labelsPatch : undefined,
      platformFacets:
        Object.keys(facetsPatch).length > 0 ? facetsPatch : undefined,
      // platformSlotSeq is deliberately NOT patched — the counter never
      // rewinds, so this slot key is retired for good. Any card still pointing
      // at it now resolves to nothing and surfaces as an orphaned ref, which
      // is recoverable; silently repointing it at a different set is not.
      //
      // Only touch primaryPlatformId when we actually detached the primary —
      // leave it untouched otherwise (matches the rest of this mutation's
      // minimal-patch convention).
      ...(isPrimary ? { primaryPlatformId: primaryPatch } : {}),
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
    // NEO-137: the SLOT key — see detachPlatformId for why the marketplace ID
    // is no longer a unique handle.
    slot: v.string(),
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
    if (!isSlotKeyForSide(args.side, args.slot)) {
      throw new Error(
        `renamePlatformLabel: "${args.slot}" is not a valid ${args.side} slot key`,
      );
    }
    if (idForSlot(row, args.side, args.slot) === undefined) {
      throw new Error(
        `Cannot rename label for unattached slot (${args.side}=${args.slot})`,
      );
    }
    const trimmed = args.label.trim();
    if (!trimmed) {
      throw new Error("Label cannot be empty");
    }
    if (trimmed.length > MAX_LABEL_LENGTH) {
      throw new Error(`Label exceeds ${MAX_LABEL_LENGTH} chars`);
    }

    const sideLabels = {
      ...(row.platformLabels?.[args.side] ?? {}),
      [args.slot]: trimmed,
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
 * NEO-96: rename a selectorOptions row's DISPLAY value.
 *
 * Until now `value` was write-once — set at insert (storeSelectorOptions /
 * addCustomSelectorOption) and never patched anywhere in this file. There was
 * no way, in the UI or the backend, to fix a typo or relabel a sport, year,
 * manufacturer, set or variant. `renamePlatformLabel` above renames a
 * MARKETPLACE label, which is a different thing entirely.
 *
 * This is only safe to expose now that entities reference sport rows by id
 * rather than copying their display string: renaming used to mean silently
 * orphaning every team/player that had stored the old label, and would also
 * have broken SKU generation and enrichment, which keyed off the display name.
 * Both of those now read `sportConfig` on the row, so a rename touches nothing
 * but the label.
 *
 * Deliberately does NOT touch `platformData`. The display title and the
 * marketplace mapping are independent by design — that separation is the whole
 * point of the NEO-96 work, and a rename must not silently remap a row to a
 * different marketplace set.
 */
/**
 * NEO-211 F — a non-custom `variantType` row's value is refused here.
 *
 * The value drives Base detection in SetSelector, `getBaseVariantBySet`, and
 * the BSC checklist fetch's `variant` facet, so renaming one silently
 * re-points a checklist at a different marketplace facet. Custom variantType
 * rows are NB's own and stay renameable. The refusal is a ConvexError with a
 * machine-readable `code` so the FE can hide the control rather than
 * string-matching a message.
 */
export const renameSelectorOption = mutation({
  args: {
    id: v.id("selectorOptions"),
    value: v.string(),
  },
  returns: v.object({ success: v.boolean(), message: v.string() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    const row = await ctx.db.get(args.id);
    if (!row) {
      throw new Error(`selectorOptions row not found: ${args.id}`);
    }

    if (refusesValueRename(row)) {
      throw new ConvexError({
        code: VARIANT_TYPE_RENAME_REFUSED,
        message: VARIANT_TYPE_RENAME_MESSAGE,
      });
    }

    // Same normalized-compare rule addCustomSelectorOption uses, scoped to
    // siblings. Read even for a no-op so the one shared rename path always
    // sees the same inputs whichever caller reached it.
    const siblings = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", row.level).eq("parentId", row.parentId),
      )
      .collect();

    const plan = planValueRename({ row, nextValue: args.value, siblings });
    if (!plan.ok) throw new Error(plan.message);
    if (plan.unchanged) return { success: true, message: "Unchanged" };

    await ctx.db.patch(row._id, {
      value: plan.value,
      ...(plan.features ? { features: plan.features } : {}),
      ...(plan.sportConfig ? { sportConfig: plan.sportConfig } : {}),
      lastUpdated: Date.now(),
    });
    return { success: true, message: `Renamed to "${plan.value}"` };
  },
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
 * Walk a selectorOptions node's parent chain ONCE, collecting the two ancestor
 * display values listing generation needs: the setName ("Chrome") and the
 * sport ("Baseball").
 *
 * NEO-101 widened this from `findSetNameValue`, which returned early at the
 * setName level. The sport node sits ABOVE setName, so a second helper would
 * have meant a second walk over the same chain for every card previewed or
 * hand-added — the walk is the cost here, not the comparison, so both values
 * come out of one pass.
 *
 * Still deliberately narrow rather than a general ancestor-chain utility:
 * every other consumer of the chain already had its own reason to walk it
 * (commitCardChecklist resolves both in the prelude, once per commit, and
 * hands them to the chunks). Depth-bounded like
 * `findSportForSelectorOption`, so a cyclic or corrupted `parentId` cannot
 * spin a query.
 */
async function findAncestorLabels(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<any> } },
  node: any,
): Promise<{ setName?: string; sport?: string }> {
  const labels: { setName?: string; sport?: string } = {};
  if (!node) return labels;
  let current = node;
  let depth = 0;
  while (current && depth < 16) {
    if (current.level === "setName" && labels.setName === undefined) {
      labels.setName = current.value;
    }
    if (current.level === "sport" && labels.sport === undefined) {
      labels.sport = current.value;
    }
    if (labels.setName !== undefined && labels.sport !== undefined) break;
    const parentId: Id<"selectorOptions"> | undefined = current.parentId;
    if (!parentId) break;
    current = await ctx.db.get(parentId);
    depth += 1;
  }
  return labels;
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

// NEO-203: `storeCardChecklist` lived here — a public mutation with zero
// callers that upserted a checklist keyed on cardNumber alone, deleted every
// non-custom row whose number was absent from the payload, and blanket-patched
// marketplace content over NB rows. All three are exactly what this ticket
// removed from the live commit path, so it was deleted rather than re-keyed
// (decision log, 2026-09-01). `commitCardChecklist` is the only write path into
// `cardChecklist` from a marketplace fetch.

/**
 * NEO-208 security condition — a bound on one operator-typed entity name.
 *
 * `addCustomCard`'s `players` / `teams` args are free text that lands in
 * `pendingPlayerNames` / `pendingTeamNames` and is then read back by the
 * listing-title generator, the entity-review wizard and the row sub-line. A
 * real player or team name is nowhere near this long; the cap exists so a
 * direct caller cannot park an essay on a row that several screens render.
 * Over-length is a hard refusal rather than a silent trim: quietly storing
 * something other than what the caller sent is how a name gets mangled and
 * then confirmed as correct in the wizard.
 */
const MAX_PENDING_NAME_LENGTH = 120;

/**
 * NEO-208 security condition — how many typed TEAM names one `addCustomCard`
 * call may carry.
 *
 * Deliberately the SAME number as `MAX_CARD_TEAMS`, and for the same reason:
 * it is a sanity bound on a hand-typed field, not a marketplace rule. A team
 * card names at most a handful of teams, so this sits well above anything
 * legitimate while still being a hard bound.
 */
const MAX_PENDING_TEAM_NAMES = MAX_CARD_TEAMS;

/**
 * NEO-208 follow-up — how many typed PLAYER names one `addCustomCard` call may
 * carry. Deliberately WIDER than `MAX_PENDING_TEAM_NAMES`: a team card or a
 * multi-player insert (League Leaders, rookie combos) can legitimately list
 * well past `MAX_CARD_TEAMS` players, where a card is never printed for more
 * than a handful of teams. 20 is a sanity bound on a hand-typed field, not a
 * marketplace rule — chosen to sit comfortably above the widest real
 * multi-player card while still being a hard cap.
 */
const MAX_PENDING_PLAYER_NAMES = 20;

/**
 * Trim, drop empties, and refuse a list that is too long or a name that is —
 * the shared shape of `addCustomCard`'s two free-text entity args.
 *
 * `label` only shapes the error text ("player" / "team"); `limit` is the
 * per-kind cap (`MAX_PENDING_PLAYER_NAMES` / `MAX_PENDING_TEAM_NAMES`) — both
 * errors name it so an operator — or a future client author — can see what
 * WOULD be accepted rather than only that this was not.
 */
function normalizePendingNames(
  raw: ReadonlyArray<string> | undefined,
  label: string,
  limit: number,
): string[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw.map((n) => n.trim()).filter((n) => n.length > 0);
  if (names.length > limit) {
    throw new ConvexError(
      `A card can carry at most ${limit} ${label} names.`,
    );
  }
  for (const name of names) {
    if (name.length > MAX_PENDING_NAME_LENGTH) {
      // The LENGTH, never the name itself: this string travels through
      // Convex's error path into Sentry and the browser console, and row
      // content has no business there (same rule as the listing-title cap).
      throw new ConvexError(
        `A ${label} name is ${name.length} characters; the limit is ${MAX_PENDING_NAME_LENGTH}.`,
      );
    }
  }
  return names;
}

/**
 * NEO-102/NEO-208 — validate a full-replacement `teamOnCardIds` write, and
 * hand back the linked teams' names.
 *
 * Shared by the TWO mutations that can put team ids on a `cardChecklist` row:
 * `updateCard` (the card detail panel's TeamPicker and the attention walker's
 * MissingTeamFixer) and, since NEO-208, `addCustomCard` (the quick-add form's
 * TeamPicker). Both reach admin clients whose caps are UI only, so neither may
 * lean on the client: an admin calling either mutation directly must not be
 * able to write an unbounded array, a pile of duplicate ids, or an id that
 * doesn't resolve to a real team in this card's sport.
 *
 * It exists as ONE function rather than two copies precisely because the two
 * call sites are the same promise to the operator — a card born with a team is
 * validated exactly as a card given one later. A second implementation is how
 * the quick-add path would end up accepting something the drawer rejects.
 *
 * Dedupes FIRST, preserving the caller's order (the array is display order,
 * not just a set), so a client that double-submits the same chip doesn't get
 * counted twice against `MAX_CARD_TEAMS`.
 *
 * `selectorOptionId` is the row the card lives (or is about to live) under —
 * `addCustomCard` holds it as an argument, `updateCard` reads it off the
 * stored card. It is only used to resolve the sport, and only when there is at
 * least one id to check; an empty write costs nothing beyond the caller's own
 * row read.
 *
 * The returned `names` are the rows this function already read, so a caller
 * that needs display names (the listing-title generator) does not read them a
 * second time. Order matches `ids`.
 */
async function resolveTeamOnCardIdsForWrite(
  ctx: QueryCtx,
  selectorOptionId: Id<"selectorOptions">,
  requested: ReadonlyArray<Id<"teams">>,
): Promise<{ ids: Array<Id<"teams">>; names: string[] }> {
  const ids: Array<Id<"teams">> = [];
  const seen = new Set<string>();
  for (const teamId of requested) {
    if (seen.has(teamId)) continue;
    seen.add(teamId);
    ids.push(teamId);
  }
  if (ids.length > MAX_CARD_TEAMS) {
    throw new ConvexError(
      `A card can carry at most ${MAX_CARD_TEAMS} teams.`,
    );
  }
  if (ids.length === 0) return { ids, names: [] };

  // Cheap: one indexed ancestor walk plus one read per team, both already
  // paid for elsewhere on these mutations' write paths
  // (`findSportForSelectorOption` mirrors the lookup `applyBscTeamResolution`
  // and the commit chunk already do).
  const sportId = await findSportForSelectorOption(ctx, selectorOptionId);
  const teamRows = await Promise.all(ids.map((teamId) => ctx.db.get(teamId)));
  const names: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const team = teamRows[i];
    if (!team) {
      throw new ConvexError("One of the selected teams no longer exists.");
    }
    // Only enforced when the card's own sport is resolvable — an orphaned
    // ancestor chain (see the ambiguous-row note on
    // `findSportForSelectorOption`) must not turn an otherwise-valid team
    // edit into a hard failure.
    if (sportId && team.sportId !== sportId) {
      throw new ConvexError(
        `"${team.name}" is not a team in this card's sport.`,
      );
    }
    names.push(team.name);
  }
  return { ids, names };
}

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
    //
    // Bounded by `normalizePendingNames` (count and per-name length) — see the
    // note there for why an over-long name is refused rather than trimmed.
    players: v.optional(v.array(v.string())),
    /**
     * Team NAMES, as free text — the pre-NEO-208 shape.
     *
     * NEO-208 gave the quick-add form a real `TeamPicker`, so the current SPA
     * sends `teamOnCardIds` below and never this. It stays accepted for an old
     * SPA bundle still in a tab mid-cutover (a Vercel deploy does not reload
     * anybody's browser), and it behaves exactly as it always did: the names
     * land in `pendingTeamNames` and the next sync's resolve pass turns them
     * into real links. Remove it once no client can still be running that
     * bundle.
     */
    teams: v.optional(v.array(v.string())),
    /**
     * NEO-208 — the teams printed on this card, as real `teams` ids.
     *
     * The quick-add form's `TeamPicker` produces these, so a hand-added card
     * is now born LINKED rather than born with a typed name nothing rendered
     * (that invisibility is the whole of NEO-208). Validated by exactly the
     * helper `updateCard` uses — see `resolveTeamOnCardIdsForWrite`.
     */
    teamOnCardIds: v.optional(v.array(v.id("teams"))),
  },
  returns: v.id("cardChecklist"),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const pendingPlayerNames = normalizePendingNames(
      args.players,
      "player",
      MAX_PENDING_PLAYER_NAMES,
    );
    const typedTeamNames = normalizePendingNames(
      args.teams,
      "team",
      MAX_PENDING_TEAM_NAMES,
    );

    // NEO-208 — validated BEFORE anything is written, so a bad id (unknown,
    // wrong sport, over the cap) leaves no half-created card behind. The
    // returned names are the rows this already read; the listing title below
    // uses them rather than reading the same teams a second time.
    const { ids: teamOnCardIds, names: linkedTeamNames } =
      await resolveTeamOnCardIdsForWrite(
        ctx,
        args.selectorOptionId,
        args.teamOnCardIds ?? [],
      );
    const hasLinkedTeams = teamOnCardIds.length > 0;

    // A real link is the same statement a typed name was reaching for, so the
    // two never coexist on a row this mutation writes — mirroring
    // `updateCard`, which retires `pendingTeamNames` whenever it writes a
    // non-empty `teamOnCardIds`. Nothing sends both today (the current SPA
    // sends ids only, an old bundle sends names only); this is what keeps a
    // future caller from producing a row that says its team twice.
    const pendingTeamNames = hasLinkedTeams ? undefined : typedTeamNames;

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
    const { setName: setNameValue, sport: sportValue } =
      await findAncestorLabels(ctx, parentNode);
    const listingInputs: ListingCardInputs = {
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
      // NEO-101: the add-custom-card form has no print-run field either (see
      // `cardVariation` below); both arrive later through `updateCard`.
      printRun: undefined,
      // NEO-101: named explicitly even though it is always absent here — the
      // add-custom-card form has no variation field, so a custom card acquires
      // its `cardVariation` later via `updateCard` (which never regenerates the
      // title; write-once). Spelled out so this stays visibly the same input
      // shape as the commit insert branch below.
      cardVariation: undefined,
      // NEO-208: a hand-added card CAN now be born linked — the quick-add
      // form's TeamPicker sends real `teams` ids — so the title says the
      // linked teams' stored names, read once by
      // `resolveTeamOnCardIdsForWrite` above.
      //
      // NEO-101's fallback still stands underneath it, for an old SPA bundle
      // that sent `teams: [string]`: those names live in `pendingTeamNames`
      // until a sync resolves them (see `deriveCardAttention`, which counts a
      // pending name as an answer for exactly the same reason). Either way the
      // title says what the operator meant, resolved or not.
      teamNames: hasLinkedTeams ? linkedTeamNames : pendingTeamNames,
      sport: sportValue,
    };
    const listingTitle = assessListingTitle(listingInputs);

    // Insert with a placeholder sortOrder; restampCardChecklistSortOrders
    // below assigns the correct natural-cardNumber position. This way a
    // user can add #42 to a set already containing #1..#100 and the new
    // row slots between #41 and #43 instead of appended at the end.
    const id = await ctx.db.insert("cardChecklist", {
      selectorOptionId: args.selectorOptionId,
      cardNumber: args.cardNumber,
      cardName: args.cardName,
      // NEO-26/NEO-208: legacy `team` string removed long ago. Teams reach a
      // new card one of two ways — real ids from the quick-add TeamPicker
      // (`teamOnCardIds`, below), or, from an old SPA bundle only, typed names
      // that become `pendingTeamNames` and are resolved by the next sync. The
      // two are mutually exclusive by construction (see `pendingTeamNames`
      // above).
      attributes: args.attributes,
      platformData: {},
      isCustom: true,
      ...(pendingPlayerNames && pendingPlayerNames.length > 0
        ? { pendingPlayerNames }
        : {}),
      ...(pendingTeamNames && pendingTeamNames.length > 0
        ? { pendingTeamNames }
        : {}),
      ...(hasLinkedTeams ? { teamOnCardIds } : {}),
      ...(featuresOrUndefined ? { features: featuresOrUndefined } : {}),
      listingTitle: listingTitle.title,
      listingDescription: generateListingDescription(listingInputs),
      // NEO-101: recorded only when the core actually had to be cut — the
      // field is absent, not `false`, on the overwhelming majority of rows
      // that fit fine (mean real title length is 34 characters).
      ...(listingTitle.coreFits ? {} : { listingTitleTruncated: true }),
      sortOrder: 0,
      lastUpdated: Date.now(),
    });

    await restampCardChecklistSortOrders(ctx, args.selectorOptionId);

    // NEO-91: same insert-then-patch SKU generation as commitCardChecklist.
    // NEO-96: SKU prefix comes from the sport ROW's config, so this path and
    // commitCardChecklist can no longer disagree (they used to emit NB-BB- and
    // NB-BA- for the same set, because one passed "Baseball" and the other the
    // lowercased "baseball" into a capitalized-keyed map).
    const skuSportId = await findSportForSelectorOption(ctx, args.selectorOptionId);
    const skuSportRow = skuSportId ? await ctx.db.get(skuSportId) : null;
    await ctx.db.patch(id, {
      sku: generateSku({
        skuCode: skuSportRow?.sportConfig?.skuCode,
        sportFallbackLabel: skuSportRow?.value ?? "",
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
    // NEO-101: the hard title cap, enforced HERE because this is the single
    // mutation every operator title edit goes through — the card detail panel
    // and the attention walker's title fixer both land on it, and the panel's
    // own counter is UI only. eBay REJECTS an over-length title rather than
    // truncating it (see features/listingLimits.ts), so an unbounded write
    // here is a listing that fails months later, at re-list time, across a
    // whole hand-built set at once.
    //
    // Trim first, so trailing whitespace an operator could not see is neither
    // stored nor counted against them.
    //
    // The error message carries the CAP and the LENGTH and never the title
    // itself: this string travels through Convex's error path into Sentry and
    // the browser console, and row content has no business there.
    // NEO-101 security follow-up: the two branches below both need the STORED
    // row. Loaded lazily and at most once — the common `updateCard` call is a
    // plain field patch that enters neither branch and must not pay for a read
    // it never uses.
    let storedCard: Doc<"cardChecklist"> | null = null;
    let storedCardLoaded = false;
    const loadStoredCard = async (): Promise<Doc<"cardChecklist">> => {
      if (!storedCardLoaded) {
        storedCard = await ctx.db.get(id);
        storedCardLoaded = true;
      }
      if (!storedCard) throw new ConvexError("updateCard: no such card");
      return storedCard;
    };

    if (typeof filtered.listingTitle === "string") {
      const trimmedTitle = filtered.listingTitle.trim();
      if (trimmedTitle.length > LISTING_TITLE_MAX) {
        throw new ConvexError(
          `Listing title is ${trimmedTitle.length} characters; the limit is ${LISTING_TITLE_MAX}.`,
        );
      }
      filtered.listingTitle = trimmedTitle;
      // A human has now authored this title, so whether the GENERATOR's core
      // fit is no longer a question anyone is asking — `undefined` in a patch
      // is how Convex deletes a field.
      //
      // ONLY WHEN THE TITLE ACTUALLY CHANGED, though. `CardDetailPanel` sends
      // `listingTitle` on EVERY save, whether or not the operator touched it,
      // so keying the clear off "present in args" meant adding a team or
      // flipping RC silently retired the "auto title was cut short" item —
      // the row stops being badged while the title is still missing the words
      // the generator cut. Same discipline as the `teamNoneConfirmedAt`
      // retirement below, which is likewise conditioned on the write being a
      // real one rather than merely present.
      const existingTitle = (await loadStoredCard()).listingTitle;
      if (trimmedTitle !== existingTitle) {
        filtered.listingTitleTruncated = undefined;
      }
    }

    // NEO-101 deliberately does NOT cap `cardVariation` here, even though
    // eBay's aspect-value limit is 65. No NB field is yet proven to map
    // verbatim onto an eBay item specific, and hard-blocking an operator edit
    // on that guess is the over-structuring NEO-189 rolled back. It surfaces
    // as a warn-only `aspectValueOverLimit` attention item instead.

    // NEO-102 security follow-up: `teamOnCardIds` arrives from admin clients
    // — the card detail panel's TeamPicker, the attention walker's
    // MissingTeamFixer, and (NEO-208) the quick-add form's TeamPicker via
    // `addCustomCard` — and the 8-team cap those enforce is UI only. The
    // validation lives in `resolveTeamOnCardIdsForWrite` above, shared
    // verbatim with `addCustomCard` so the born-with-a-team path and the
    // given-one-later path cannot diverge on what they accept.
    if (Array.isArray(filtered.teamOnCardIds)) {
      const { ids } = await resolveTeamOnCardIdsForWrite(
        ctx,
        (await loadStoredCard()).selectorOptionId,
        filtered.teamOnCardIds as Array<Id<"teams">>,
      );
      filtered.teamOnCardIds = ids;
    }

    // NEO-102: giving this card a real team RETIRES the operator's "no team"
    // confirmation, in the same patch, so the two can never contradict each
    // other on the row.
    //
    // DERIVED from the write, never accepted as an argument. Note that this
    // mutation patches a filtered SPREAD of its own args — adding
    // `teamNoneConfirmedAt` to the validator above would make a
    // review-suppression timestamp directly settable by any admin client,
    // which is exactly what the schema comment forbids. Patching `undefined`
    // is how Convex deletes a field.
    //
    // Only a NON-EMPTY write clears it. `teamOnCardIds: []` is the operator
    // unlinking every team, which leaves the card teamless and the
    // confirmation still true.
    const writtenTeamIds = filtered.teamOnCardIds;
    if (Array.isArray(writtenTeamIds) && writtenTeamIds.length > 0) {
      filtered.teamNoneConfirmedAt = undefined;
      filtered.teamNoneConfirmedByUserId = undefined;
      // NEO-208: and it retires any TYPED team name still sitting on the row.
      // `pendingTeamNames` is "the operator named a team no `teams` row
      // existed for yet"; linking a real team is that same intent, answered.
      // Leaving both would print the row's team twice — once resolved, once
      // as "(unconfirmed)" in the row sub-line and the drawer — and would
      // leave the next sync's resolve pass still chasing a name nobody is
      // waiting on. Same discipline as the two fields above: DERIVED from the
      // write, never accepted as an argument (it is not in this mutation's
      // validator), and only on a NON-EMPTY write — `teamOnCardIds: []` is the
      // operator unlinking every team, which leaves the typed name as the only
      // thing the row still knows about its team.
      filtered.pendingTeamNames = undefined;
    }
    if (Object.keys(filtered).length > 0) {
      await ctx.db.patch(id, { ...filtered, lastUpdated: Date.now() });
    }
    return null;
  },
});

/**
 * NEO-101 — what the generator WOULD title this stored card today, plus the
 * inputs it would use.
 *
 * Read-only, and it stores nothing. Two consumers, both in the card detail
 * panel / attention walker: a **Regenerate** button that resets the title draft
 * to this, and the labelled source chips (year, set, players, #, flags,
 * variation) that show an operator WHICH facts the machine had — so when a
 * title has to be shortened by hand, they can see what is safe to drop rather
 * than guessing.
 *
 * ## Why a query and not a client-side call
 *
 * `assessListingTitle` is pure and the SPA could call it directly — but the
 * inputs are not on the row. Player NAMES live behind `playerIds`, and the set
 * name is an ancestor walk. Resolving those client-side would mean a second
 * round of queries per card and a second place that can disagree with what the
 * insert branch actually did.
 *
 * ## Kept in step with the insert branch by hand
 *
 * The field mapping below MIRRORS `commitCardChecklistChunk`'s insert branch
 * (search `listingInputs` in this file) — same six feature keys, same
 * `findSetNameValue` ancestor walk, same verbatim `cardVariation`. It is NOT
 * shared code: the commit reads a merged features snapshot it computed a few
 * lines earlier for a card that does not exist yet, this reads a stored row's
 * own `features`. Folding those into one helper would mean a parameter object
 * with the same shape as `ListingCardInputs` itself, which is the thing being
 * built. **If you change one, change the other.**
 *
 * The one real difference is `playerNames`: a committed card has resolved
 * `playerIds`, a custom card added by hand may still only have
 * `pendingPlayerNames` (the names an operator typed, not yet reconciled to
 * `players` rows). Both are the operator's answer, so both are used — resolved
 * ids first, pending names as the fallback, exactly as `addCustomCard` does.
 */
export const previewListingTitle = query({
  args: { cardId: v.id("cardChecklist") },
  returns: v.object({
    title: v.string(),
    coreFits: v.boolean(),
    dropped: v.array(v.string()),
    inputs: v.object({
      cardNumber: v.string(),
      playerNames: v.array(v.string()),
      year: v.optional(v.string()),
      manufacturer: v.optional(v.string()),
      setName: v.optional(v.string()),
      parallelName: v.optional(v.string()),
      isRookie: v.optional(v.boolean()),
      isRelic: v.optional(v.boolean()),
      autographed: v.optional(v.string()),
      shortPrint: v.optional(v.string()),
      printRun: v.optional(v.number()),
      cardVariation: v.optional(v.string()),
      // NEO-101: always present, possibly empty — same contract as
      // `playerNames`, so the chips can render it without a null check.
      teamNames: v.array(v.string()),
      sport: v.optional(v.string()),
    }),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const card = await ctx.db.get(args.cardId);
    if (!card) throw new ConvexError("previewListingTitle: no such card");

    // NEO-101 security follow-up: BOUND AND DEDUPE the fan-out before reading
    // anything. `playerIds` is an unvalidated array on the row — `updateCard`
    // accepts it as full replacement with no cap and no de-duplication, unlike
    // `teamOnCardIds` (see `MAX_CARD_TEAMS` there) — so a single call to this
    // query could otherwise turn one card id into an unbounded sequential
    // `ctx.db.get` walk. Deduping first also stops a row that repeats the same
    // id from paying for it twice, and from printing the player twice.
    //
    // The cap is deliberately generous rather than tight: the widest real
    // multi-player cards (League Leaders, rookie combos) run to a handful of
    // names, and a title only has room for two or three of them anyway, so 12
    // is well past anything legitimate while still being a hard bound.
    //
    // Not fixed by adding a `MAX_CARD_PLAYERS` to `updateCard` here: doing
    // that properly means dedupe + cap + existence checks on the write path,
    // which changes an input contract `CardDetailPanel` and the commit path
    // both use, and that is its own decision rather than a preview query's to
    // make. This bound is local and costs nothing.
    const PREVIEW_PLAYER_LOOKUP_LIMIT = 12;
    const previewPlayerIds = [...new Set(card.playerIds ?? [])].slice(
      0,
      PREVIEW_PLAYER_LOOKUP_LIMIT,
    );
    const resolvedPlayerNames: string[] = [];
    for (const playerId of previewPlayerIds) {
      const player = await ctx.db.get(playerId);
      // A dangling id is a data problem, not a reason to fail a preview —
      // skip it and let the chips show what actually resolved.
      if (player) resolvedPlayerNames.push(player.name);
    }
    const playerNames =
      resolvedPlayerNames.length > 0
        ? resolvedPlayerNames
        : (card.pendingPlayerNames ?? []);

    // Teams get the same treatment as players — deduped and BOUNDED before any
    // read. The bound here is `MAX_CARD_TEAMS`, which is what `updateCard`
    // already enforces on the write path, so a row that went through the
    // supported path can never be truncated by it; the cap exists for rows
    // written before that validation landed, or by a future caller that skips
    // it.
    const previewTeamIds = [...new Set(card.teamOnCardIds ?? [])].slice(
      0,
      MAX_CARD_TEAMS,
    );
    const resolvedTeamNames: string[] = [];
    for (const teamId of previewTeamIds) {
      const team = await ctx.db.get(teamId);
      if (team) resolvedTeamNames.push(team.name);
    }
    // Same fallback as `playerNames`: a hand-added card carries the names the
    // operator typed until a sync resolves them into `teams` rows, and those
    // are the operator's answer.
    const teamNames =
      resolvedTeamNames.length > 0
        ? resolvedTeamNames
        : (card.pendingTeamNames ?? []).slice(0, MAX_CARD_TEAMS);

    const features: Record<string, string> = card.features ?? {};
    const parentNode = await ctx.db.get(card.selectorOptionId);
    const { setName: setNameValue, sport: sportValue } =
      await findAncestorLabels(ctx, parentNode);

    const inputs: ListingCardInputs = {
      cardNumber: card.cardNumber,
      playerNames,
      year: features.season,
      manufacturer: features.manufacturer,
      setName: setNameValue,
      parallelName: features.parallelName,
      isRookie: card.isRookie,
      isRelic: card.isRelic,
      autographed: features.autographed,
      shortPrint: features.shortPrint,
      printRun: card.printRun,
      cardVariation: card.cardVariation,
      teamNames,
      sport: sportValue,
    };

    const { title, coreFits, dropped } = assessListingTitle(inputs);
    return {
      title,
      coreFits,
      dropped,
      inputs: { ...inputs, playerNames, teamNames },
    };
  },
});

/**
 * NEO-21: every place in this file that deletes a `cardChecklist` row must
 * drop its `cardCrossListings` junction rows first, or a guest checklist
 * keeps rendering a link to a card that no longer exists. Shared so the
 * handful of stale-card-cleanup loops (marketplace re-sync, legacy-migration
 * wipe, manual delete, dev-only reset) can't drift out of sync with each
 * other on this invariant.
 */
async function deleteCardCrossListingsFor(
  ctx: { db: { query: any; delete: (id: any) => Promise<void> } },
  cardChecklistId: Id<"cardChecklist">,
): Promise<void> {
  const crossListings = await ctx.db
    .query("cardCrossListings")
    .withIndex("by_card", (q: any) => q.eq("cardChecklistId", cardChecklistId))
    .collect();
  for (const link of crossListings) {
    await ctx.db.delete(link._id);
  }
}

/**
 * NEO-189 — a deleted card must not leave its VARIATIONS pointing at a row that
 * no longer exists.
 *
 * Same invariant `deleteCardCrossListingsFor` exists for, one table over: every
 * path that deletes a `cardChecklist` row has to tidy what points at it.
 *
 * The children are PROMOTED, not deleted. A variation is a full card in its own
 * right — its own players, its own SKU, its own platform refs — so losing its
 * parent must not lose the card. It becomes an ordinary card, and an operator
 * can re-parent it. Deleting a parent's variations along with it would destroy
 * real catalog data as a side effect of one click.
 */
async function orphanVariationsOf(
  ctx: { db: { query: any; patch: (id: any, patch: any) => Promise<void> } },
  cardChecklistId: Id<"cardChecklist">,
): Promise<void> {
  const children = await ctx.db
    .query("cardChecklist")
    .withIndex("by_variation_parent", (q: any) =>
      q.eq("variationOfCardId", cardChecklistId),
    )
    .collect();
  for (const child of children) {
    await ctx.db.patch(child._id, {
      variationOfCardId: undefined,
      lastUpdated: Date.now(),
    });
  }
}

/**
 * NEO-189 — set or clear a card's variation parent by hand.
 *
 * The import derivation handles the common shape (BSC suffixes a number,
 * SportLots brackets a description), but it cannot cover everything: a
 * variation whose number shares no stem with its parent, a set the operator is
 * building by hand, or simply a case the rule got wrong. This is the escape
 * hatch, and it is the only way a custom set gets variations at all.
 *
 * The link is marked `variationParentManual`, which the commit pass skips —
 * see the note on the schema field. An operator's answer is not re-derived.
 *
 * ## What is refused, and why
 *
 * A card may not be its own parent, and a parent must live in the SAME
 * checklist: a variation belongs to the card it varies, and the two are by
 * definition the same slot in the same set.
 *
 * A variation may not parent another variation. Variations are one level deep
 * — "#1c is a variation of #1b" describes nothing real, and allowing it means
 * the set builder has to render an arbitrarily deep tree and guard against
 * cycles. Rejecting it here keeps that impossible rather than merely unlikely.
 *
 * Making a card a parent while it is itself someone's variation is refused for
 * the same reason, from the other direction.
 *
 * Those refusals throw ConvexError, not Error. Production Convex REDACTS a
 * thrown Error's message to "Server Error" while dev and preview pass it
 * through — so an operator-facing explanation written as an Error reads
 * perfectly in testing and flattens to nothing on prod. `convex/postage.ts`
 * documents the same trap, found live on a real purchase attempt. Every
 * message here is meant for the person using the panel, so every one of them
 * is a ConvexError.
 */
export const setCardVariationParent = mutation({
  args: {
    cardId: v.id("cardChecklist"),
    // Absent clears the link, turning the card back into an ordinary one.
    parentCardId: v.optional(v.id("cardChecklist")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const card = await ctx.db.get(args.cardId);
    if (!card) throw new Error("setCardVariationParent: no such card");

    if (!args.parentCardId) {
      await ctx.db.patch(args.cardId, {
        variationOfCardId: undefined,
        // Clearing is itself an operator decision: without keeping the marker,
        // the next sync would re-derive the very link they just removed.
        variationParentManual: true,
        lastUpdated: Date.now(),
      });
      return null;
    }

    if (args.parentCardId === args.cardId) {
      throw new ConvexError("A card cannot be a variation of itself.");
    }
    const parent = await ctx.db.get(args.parentCardId);
    if (!parent) throw new Error("setCardVariationParent: no such parent card");
    if (parent.selectorOptionId !== card.selectorOptionId) {
      throw new ConvexError(
        "A variation must belong to the same checklist as the card it varies.",
      );
    }
    if (parent.variationOfCardId) {
      throw new ConvexError(
        "That card is itself a variation. Variations are one level deep — pick the base card instead.",
      );
    }
    const ownChildren = await ctx.db
      .query("cardChecklist")
      .withIndex("by_variation_parent", (q) =>
        q.eq("variationOfCardId", args.cardId),
      )
      .first();
    if (ownChildren) {
      throw new ConvexError(
        "This card has its own variations. Move them first, or variations would nest.",
      );
    }

    await ctx.db.patch(args.cardId, {
      variationOfCardId: args.parentCardId,
      variationParentManual: true,
      lastUpdated: Date.now(),
    });
    return null;
  },
});

export const deleteCard = mutation({
  args: { id: v.id("cardChecklist") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    await deleteCardCrossListingsFor(ctx, args.id);
    await orphanVariationsOf(ctx, args.id);
    await ctx.db.delete(args.id);
    return null;
  },
});

// ===========================================================================
// NEO-21: cross-release listings
// ===========================================================================
//
// A card physically printed in one product can complete a different product's
// checklist (2021 Score #301-320 shipped inside 2022 Chronicles packs). The
// card row stays pinned to where it was printed — release year, SKU and
// provenance all resolve off `cardChecklist.selectorOptionId` and must keep
// resolving to the home set. `cardCrossListings` only adds a second place the
// card is *displayed*. Admin-only tooling for now.

// The UI caps a single range/list expansion at the same number (see
// MAX_EXPANDED_NUMBERS in CrossListingImportModal.tsx) — mirrored server-side
// so a direct API call can't hand this mutation an unbounded batch just
// because the client-side cap is only advisory.
const MAX_CROSS_LISTING_CARD_NUMBERS = 1000;

export const addCrossListingsByCardNumbers = mutation({
  args: {
    // Where the cards actually live (the home set, already fetched from the
    // marketplace) — we link existing rows, never create card data.
    sourceSelectorOptionId: v.id("selectorOptions"),
    // The guest checklist the operator has open and wants them to show up in.
    targetSelectorOptionId: v.id("selectorOptions"),
    cardNumbers: v.array(v.string()),
  },
  returns: v.object({
    linked: v.array(v.string()),
    alreadyLinked: v.array(v.string()),
    notFound: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const userId = await requireAdmin(ctx);
    if (args.sourceSelectorOptionId === args.targetSelectorOptionId) {
      throw new Error("Cannot cross-list a set into itself");
    }
    if (args.cardNumbers.length > MAX_CROSS_LISTING_CARD_NUMBERS) {
      throw new Error(
        `Too many card numbers in one request (${args.cardNumbers.length}); ` +
          `max ${MAX_CROSS_LISTING_CARD_NUMBERS}.`,
      );
    }

    // cardChecklist.selectorOptionId only ever points at a variant-level row
    // (variantType/insert/parallel — see schema.ts). Reject anything else up
    // front instead of silently returning an all-notFound/no-op result for a
    // sport/year/manufacturer/setName id, which would look like "nothing
    // matched" rather than "this isn't a valid set to cross-list from/into".
    const isVariantLevel = (level: string) =>
      ["variantType", "insert", "parallel"].includes(level);
    const [sourceNode, targetNode] = await Promise.all([
      ctx.db.get(args.sourceSelectorOptionId),
      ctx.db.get(args.targetSelectorOptionId),
    ]);
    if (!sourceNode || !isVariantLevel(sourceNode.level)) {
      throw new Error("Source set must be a variant-level set (Base/insert/parallel)");
    }
    if (!targetNode || !isVariantLevel(targetNode.level)) {
      throw new Error("Target set must be a variant-level set (Base/insert/parallel)");
    }

    // One read of the target's existing links covers every requested number,
    // and doubles as the de-dup guard for repeats within this one request.
    const existing = await ctx.db
      .query("cardCrossListings")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.targetSelectorOptionId),
      )
      .collect();
    const linkedCardIds = new Set<string>(
      existing.map((link) => link.cardChecklistId),
    );

    const linked: string[] = [];
    const alreadyLinked: string[] = [];
    const notFound: string[] = [];
    const now = Date.now();

    for (const cardNumber of args.cardNumbers) {
      const card = await ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option_and_number", (q) =>
          q
            .eq("selectorOptionId", args.sourceSelectorOptionId)
            .eq("cardNumber", cardNumber),
        )
        .first();
      if (!card) {
        notFound.push(cardNumber);
        continue;
      }
      if (linkedCardIds.has(card._id)) {
        alreadyLinked.push(cardNumber);
        continue;
      }
      await ctx.db.insert("cardCrossListings", {
        cardChecklistId: card._id,
        selectorOptionId: args.targetSelectorOptionId,
        createdByUserId: userId,
        lastUpdated: now,
      });
      linkedCardIds.add(card._id);
      linked.push(cardNumber);
    }

    return { linked, alreadyLinked, notFound };
  },
});

export const removeCrossListing = mutation({
  args: { crossListingId: v.id("cardCrossListings") },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    // Junction row only. The card belongs to its home set and must survive
    // being removed from a guest checklist.
    await ctx.db.delete(args.crossListingId);
    return null;
  },
});

export const getCrossListingsForCard = query({
  args: { cardChecklistId: v.id("cardChecklist") },
  returns: v.array(
    v.object({
      _id: v.id("cardCrossListings"),
      selectorOptionId: v.id("selectorOptions"),
      setLabel: v.string(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const links = await ctx.db
      .query("cardCrossListings")
      .withIndex("by_card", (q) =>
        q.eq("cardChecklistId", args.cardChecklistId),
      )
      .collect();

    const out: Array<{
      _id: Id<"cardCrossListings">;
      selectorOptionId: Id<"selectorOptions">;
      setLabel: string;
    }> = [];
    for (const link of links) {
      out.push({
        _id: link._id,
        selectorOptionId: link.selectorOptionId,
        setLabel: await buildSetLabel(ctx, link.selectorOptionId),
      });
    }
    return out;
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
      insert: selectorOptionDocValidator,
      parallels: v.array(selectorOptionDocValidator),
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
    // WIRE shape — marketplace ids. Converted to slots below (NEO-137).
    platformData: v.object({
      bsc: v.optional(v.union(v.string(), v.array(v.string()))),
      sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
      // The SL set's human display name. Stored as the SL slot's LABEL, which
      // is what replaced `platformData.sportlotsDisplay` — a single display
      // string stopped meaning anything once a row could hold several SL sets.
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
    // NEO-137: the incoming ids must be resolved to SLOTS. Spreading them
    // straight over `row.platformData` used to produce a mixed object
    // ({ bsc: { b0: "x" }, sportlots: "884412" }) that the schema rejects —
    // which broke the Base Set picker, and with it setup.yaml.
    let working: {
      platformData: typeof row.platformData;
      platformLabels: typeof row.platformLabels;
      platformSlotSeq: typeof row.platformSlotSeq;
    } = {
      platformData: row.platformData,
      platformLabels: row.platformLabels,
      platformSlotSeq: row.platformSlotSeq,
    };
    for (const [side, incoming, label] of [
      ["bsc", wireToIds(args.platformData.bsc)[0], undefined],
      [
        "sportlots",
        wireToIds(args.platformData.sportlots)[0],
        args.platformData.sportlotsDisplay,
      ],
    ] as const) {
      if (!incoming) continue;
      const next = setPrimarySlotId(working, side, incoming, label);
      working = {
        platformData: next.platformData,
        platformLabels: next.platformLabels,
        platformSlotSeq: next.platformSlotSeq,
      };
    }

    const labels = pruneEmptySides({ ...(working.platformLabels ?? {}) });
    const merged: Record<string, unknown> = {
      platformData: pruneEmptySides({ ...working.platformData }),
      lastUpdated: Date.now(),
    };
    if (Object.keys(labels).length > 0) merged.platformLabels = labels;
    if (
      working.platformSlotSeq &&
      Object.keys(working.platformSlotSeq).length > 0
    ) {
      merged.platformSlotSeq = working.platformSlotSeq;
    }
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
 * The reset itself, shared by BOTH entry points so they cannot drift:
 * `resetSetBuilderData` (the AdminTools button) and
 * `resetSetBuilderDataFromCli` (`npx convex run`). Authorisation belongs to
 * the caller — this function performs the delete unconditionally.
 */
async function runSetBuilderReset(ctx: ActionCtx): Promise<{
  selectorOptionsDeleted: number;
  cardChecklistDeleted: number;
  crossListingsDeleted: number;
  playersDeleted: number;
  teamsDeleted: number;
  leaguesDeleted: number;
}> {
    let selectorOptionsDeleted = 0;
    while (true) {
      // Well inside MAX_RETURNED_IDS: this list is one LEVEL's options for one
      // parent, de-duplicated — the biggest real case is a year's set list,
      // which SportLots tops out at a few thousand for. The store degrades
      // rather than throws if that ever stops being true.
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

    // NEO-21: cardCrossListings rows outlive nothing on their own (they're
    // pure junction rows), but a wipe that skips this table leaves them
    // pointing at cardChecklist ids that no longer exist post-reset.
    let crossListingsDeleted = 0;
    while (true) {
      const result = await ctx.runMutation(
        internal.selectorOptions.resetCardCrossListingsBatch,
        {},
      );
      crossListingsDeleted += result.deleted;
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

    // NEO-156: leagues go last, after the teams that reference them, so an
    // interrupted reset never leaves teams pointing at deleted leagues.
    let leaguesDeleted = 0;
    while (true) {
      const result = await ctx.runMutation(
        internal.selectorOptions.resetLeaguesBatch,
        {},
      );
      leaguesDeleted += result.deleted;
      if (!result.hasMore) break;
    }

    return {
      selectorOptionsDeleted,
      cardChecklistDeleted,
      crossListingsDeleted,
      playersDeleted,
      teamsDeleted,
      leaguesDeleted,
    };
}

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
    crossListingsDeleted: v.number(),
    playersDeleted: v.number(),
    teamsDeleted: v.number(),
    leaguesDeleted: v.number(),
  }),
  handler: async (
    ctx,
  ): Promise<{
    selectorOptionsDeleted: number;
    cardChecklistDeleted: number;
    crossListingsDeleted: number;
    playersDeleted: number;
    teamsDeleted: number;
    leaguesDeleted: number;
  }> => {
    // CLIENT-CALLABLE entry point (the AdminTools button). Both guards live
    // here now rather than in each batch mutation: this is the only path a
    // browser can reach, so it is the only path that needs them.
    //
    // `ALLOW_RESET_SET_BUILDER_DATA` is deliberately UNSET on prod so a
    // misdirected click cannot wipe production. Keeping that check down in the
    // batch mutations meant the CLI inherited it too, which would have forced
    // arming this button on prod just to run a reset from a terminal — see
    // `resetSetBuilderDataFromCli` below.
    await requireAdmin(ctx);
    if (process.env.ALLOW_RESET_SET_BUILDER_DATA !== "true") {
      throw new Error(
        "Reset Set Builder Data is not enabled in this environment. " +
          "Set ALLOW_RESET_SET_BUILDER_DATA=true on the Convex deployment to enable.",
      );
    }

    return await runSetBuilderReset(ctx);
  },
});

/**
 * CLI entry point for the SAME reset the AdminTools button performs.
 *
 * Runs the identical batch mutations as `resetSetBuilderData` above — one
 * implementation, so the two paths cannot drift.
 *
 *   # dev (your personal deployment)
 *   npx convex run selectorOptions:resetSetBuilderDataFromCli \
 *     '{"confirm":"RESET"}' --identity '{"role":"admin"}'
 *
 *   # production
 *   npx convex run selectorOptions:resetSetBuilderDataFromCli \
 *     '{"confirm":"RESET"}' --identity '{"role":"admin"}' --prod
 *
 * `--identity` IS REQUIRED — do not drop it. The batch mutations this calls
 * each run `requireAdmin`, which reads `ctx.auth.getUserIdentity()`. A bare
 * `convex run` carries no identity at all, so without the flag the very first
 * batch throws `Not authenticated` and nothing is deleted.
 *
 * `--identity` IS NOT A SECURITY CONTROL. Anyone running `convex run` can
 * fabricate any identity they like, admin included. The thing that actually
 * gates this is your Convex login: reaching `--prod` requires prod deploy
 * credentials. That is the real "logged in as me" check, and `requireAdmin`
 * stays on the batch mutations as defence-in-depth for other callers, not as
 * the boundary that protects prod.
 *
 * WHY THE `ALLOW_RESET_SET_BUILDER_DATA` GUARD IS NOT REPEATED HERE:
 *
 *   That flag exists to stop the AdminTools BUTTON wiping prod by a
 *   misdirected click, which is why it is unset there. An `internalAction` is
 *   unreachable from any client, so the flag would add no safety here — it
 *   would only force you to arm the button on prod in order to run a reset
 *   from a terminal, which is strictly worse.
 *
 * PRACTICAL NOTE: run this with the app CLOSED. Resetting while the Set
 * Selector is open lets the page immediately re-sync the sport column and
 * write the rows straight back — which is exactly what happened on dev during
 * NEO-137.
 */
export const resetSetBuilderDataFromCli = internalAction({
  args: {
    // `convex run` is one tab-completion away from a neighbouring function
    // name and this is unrecoverable, so make the intent explicit.
    confirm: v.literal("RESET"),
  },
  returns: v.object({
    selectorOptionsDeleted: v.number(),
    cardChecklistDeleted: v.number(),
    crossListingsDeleted: v.number(),
    playersDeleted: v.number(),
    teamsDeleted: v.number(),
    leaguesDeleted: v.number(),
  }),
  handler: async (
    ctx,
  ): Promise<{
    selectorOptionsDeleted: number;
    cardChecklistDeleted: number;
    crossListingsDeleted: number;
    playersDeleted: number;
    teamsDeleted: number;
    leaguesDeleted: number;
  }> => {
    // Same auth posture as the button — the batch mutations below enforce
    // requireAdmin, which `--identity` satisfies. This entry point differs
    // from the button in exactly one way: it does not require
    // ALLOW_RESET_SET_BUILDER_DATA, so prod can be reset from a terminal
    // without arming a prod-wiping button in the UI.
    return await runSetBuilderReset(ctx);
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
    // Auth stays HERE, as close to the delete as possible — restored after it
    // was briefly hoisted to the entry points. `convex run --identity` can
    // satisfy this from the CLI, so moving it bought nothing and cost the
    // defence-in-depth the original author put here deliberately.
    //
    // The ALLOW_RESET_SET_BUILDER_DATA check is NOT here: that flag exists to
    // stop a misdirected CLICK in AdminTools, so it belongs on the
    // client-callable entry point only. Keeping it here would force arming
    // that button on prod merely to run a reset from a terminal.
    await requireAdmin(ctx);
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
    // Auth stays HERE, as close to the delete as possible — restored after it
    // was briefly hoisted to the entry points. `convex run --identity` can
    // satisfy this from the CLI, so moving it bought nothing and cost the
    // defence-in-depth the original author put here deliberately.
    //
    // The ALLOW_RESET_SET_BUILDER_DATA check is NOT here: that flag exists to
    // stop a misdirected CLICK in AdminTools, so it belongs on the
    // client-callable entry point only. Keeping it here would force arming
    // that button on prod merely to run a reset from a terminal.
    await requireAdmin(ctx);
    const rows = await ctx.db.query("cardChecklist").take(RESET_BATCH_SIZE);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, hasMore: rows.length === RESET_BATCH_SIZE };
  },
});

/**
 * Internal: delete up to RESET_BATCH_SIZE rows from cardCrossListings
 * (NEO-21). Used by resetSetBuilderData (action) in a loop until no rows
 * remain — a dev/test reset that wiped cardChecklist but left this table
 * would carry over junction rows pointing at ids the next run reuses for
 * unrelated cards.
 */
export const resetCardCrossListingsBatch = internalMutation({
  args: {},
  returns: v.object({
    deleted: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx) => {
    // Auth stays HERE, as close to the delete as possible — restored after it
    // was briefly hoisted to the entry points. `convex run --identity` can
    // satisfy this from the CLI, so moving it bought nothing and cost the
    // defence-in-depth the original author put here deliberately.
    //
    // The ALLOW_RESET_SET_BUILDER_DATA check is NOT here: that flag exists to
    // stop a misdirected CLICK in AdminTools, so it belongs on the
    // client-callable entry point only. Keeping it here would force arming
    // that button on prod merely to run a reset from a terminal.
    await requireAdmin(ctx);
    const rows = await ctx.db.query("cardCrossListings").take(RESET_BATCH_SIZE);
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
    // Auth stays HERE, as close to the delete as possible — restored after it
    // was briefly hoisted to the entry points. `convex run --identity` can
    // satisfy this from the CLI, so moving it bought nothing and cost the
    // defence-in-depth the original author put here deliberately.
    //
    // The ALLOW_RESET_SET_BUILDER_DATA check is NOT here: that flag exists to
    // stop a misdirected CLICK in AdminTools, so it belongs on the
    // client-callable entry point only. Keeping it here would force arming
    // that button on prod merely to run a reset from a terminal.
    await requireAdmin(ctx);
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
/**
 * Internal: delete up to RESET_BATCH_SIZE rows from `leagues`.
 *
 * NEO-156 added this alongside the teams batch. A reset that wipes teams but
 * leaves their leagues standing is not a clean slate — it leaves league rows
 * nothing references, which then quietly collide with the ones seeding
 * recreates.
 */
export const resetLeaguesBatch = internalMutation({
  args: {},
  returns: v.object({
    deleted: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx) => {
    // Auth here rather than at the entry point, same as every other batch —
    // see the note in resetSelectorOptionsBatch.
    await requireAdmin(ctx);
    const rows = await ctx.db.query("leagues").take(RESET_BATCH_SIZE);
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, hasMore: rows.length === RESET_BATCH_SIZE };
  },
});

export const resetTeamsBatch = internalMutation({
  args: {},
  returns: v.object({
    deleted: v.number(),
    hasMore: v.boolean(),
  }),
  handler: async (ctx) => {
    // Auth stays HERE, as close to the delete as possible — restored after it
    // was briefly hoisted to the entry points. `convex run --identity` can
    // satisfy this from the CLI, so moving it bought nothing and cost the
    // defence-in-depth the original author put here deliberately.
    //
    // The ALLOW_RESET_SET_BUILDER_DATA check is NOT here: that flag exists to
    // stop a misdirected CLICK in AdminTools, so it belongs on the
    // client-callable entry point only. Keeping it here would force arming
    // that button on prod merely to run a reset from a terminal.
    await requireAdmin(ctx);
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
            // NEO-21: drop this card's cross-listing rows before the card.
            await deleteCardCrossListingsFor(ctx, c._id);
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
          // NEO-21: drop this card's cross-listing rows before the card.
          await deleteCardCrossListingsFor(ctx, c._id);
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
// own marketplace fetches, but if a child hangs *upstream* of the fetch — e.g. a
// stuck cold-login in getSiteToken — its promise can never settle, and a bare
// Promise.allSettled would wait forever, so fetchAggregatedOptions would never
// reach recordAdapterCall and the FE column would spin "Syncing…" with NOTHING
// logged. These deadlines guarantee each branch resolves; whichever blows its
// budget is attributed via timed_out_platform on the aggregator's
// adapter_sync_call, and by the child's own adapter_phase breadcrumb (joined on
// requestId) for which phase of the child ate the budget.
//
// NEO-198 — DERIVED, not written down. Each is the adapter's OWN ceiling plus an
// explicit margin, both imported from convex/adapters/selectorBudgets.ts. The
// previous SL value was the literal 12_000 justified by a comment reading "the
// child's own retry ceiling + margin (SL ≈ 9s)". That 9s counted only
// SL_SELECTOR_FETCH_TIMEOUT_MS × SL_SELECTOR_FETCH_MAX_ATTEMPTS and silently
// omitted the empty-result recovery loop (2 more rounds of 500ms + 3s) that runs
// inside the same budget — so the real SL ceiling was 16s under a 12s deadline,
// and the aggregator could abandon an adapter that was still working correctly
// and log it as a hang. The bug was never the number 12; it was that the number
// and the policy lived in different files with nothing tying them together.
//
// BEHAVIOUR CHANGE: SL_CHILD_DEADLINE_MS moves 12_000 → 19_500. A genuinely
// hung SportLots child is now abandoned ~7.5s later than before. That costs
// nothing when BSC also hangs (Promise.all already waits out BSC's 35s) and it
// cannot reach the FE backstop (SELECTOR_SYNC_FE_TIMEOUT_MS = 38_000, still
// above max(SL, BSC)). What it buys is that the deadline can no longer fire on
// an adapter that is inside its own documented retry policy.
//
// BSC_CHILD_DEADLINE_MS is unchanged at 35_000 — 31.5s ceiling + the same
// 3.5s margin it has always effectively run with. The derivation was applied to
// it too, but it reproduces the existing value exactly.
const SL_CHILD_DEADLINE_MS =
  SL_SELECTOR_BUDGET.ceilingMs + CHILD_DEADLINE_MARGIN_MS;
const BSC_CHILD_DEADLINE_MS =
  BSC_SELECTOR_BUDGET.ceilingMs + CHILD_DEADLINE_MARGIN_MS;

// Exported ONLY so convex/adapters/selectorBudgets.test.ts can assert the
// invariant that produced NEO-198: a child deadline must never sit below the
// ceiling of the adapter it is supposed to contain. Not a Convex function.
export const CHILD_DEADLINES_MS = {
  sportlots: SL_CHILD_DEADLINE_MS,
  bsc: BSC_CHILD_DEADLINE_MS,
} as const;

/**
 * NEO-198 — the message recorded when a child blows its deadline.
 *
 * Extracted so it can be asserted directly: the timeout path itself can only be
 * exercised by hanging a "use node" adapter for 20 seconds, which is not a unit
 * test, but the *claim the message makes* is exactly the thing that was wrong.
 *
 * What it must NOT say. The previous wording was
 *
 *   "<platform> adapter exceeded Ns deadline
 *    (no response — stalled before/within the marketplace fetch)"
 *
 * and the parenthetical is unknowable here. `withChildDeadline` resolves with
 * `{kind:"timeout"}` precisely because the child produced no value, so the
 * aggregator has no token_ms, no filters_call_ms and no status code — it cannot
 * distinguish a stall in getSiteToken (the credential path, which NEO-198
 * deliberately leaves unbounded) from a stall in the marketplace fetch. Naming a
 * location we cannot observe sends the next reader to the wrong file.
 *
 * What it does say: the fact (no return inside the budget), and where the answer
 * actually lives (the child's adapter_phase breadcrumb, joined on requestId).
 */
export function childDeadlineMessage(
  platformLabel: string,
  ms: number,
  requestId: string,
): string {
  return (
    `${platformLabel} adapter did not return within its ${ms / 1000}s deadline; ` +
    `which phase consumed it is not visible from here (requestId ${requestId})`
  );
}

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

/**
 * Write/clear the transient per-(level,parentId) sync status.
 *
 * `status` omitted = clear (delete). NEO-211 adds `"done"`: a sync that
 * succeeded but left the admin a notice — links detached because upstream
 * stopped listing them, and/or a platform that could not be reached while the
 * other stored fine. The quiet happy path still deletes the row.
 */
export const setSelectorSyncStatus = internalMutation({
  args: {
    level: levelValidator,
    parentId: v.optional(v.id("selectorOptions")),
    status: v.optional(
      v.union(v.literal("syncing"), v.literal("error"), v.literal("done")),
    ),
    message: v.optional(v.string()),
    requestId: v.optional(v.string()),
    unlinked: v.optional(v.array(unlinkedEntryValidator)),
    unlinkedTotal: v.optional(v.number()),
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
    // Every field is written on every call, including as `undefined`: a patch
    // is a shallow merge, so a "syncing" row that inherited last run's
    // `unlinked` list would show a stale notice for the whole next sync.
    const fields = {
      status: args.status,
      message: args.message,
      requestId: args.requestId,
      unlinked: args.unlinked?.slice(0, UNLINK_NOTICE_LIMIT),
      unlinkedTotal: args.unlinkedTotal,
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
      status: v.union(
        v.literal("syncing"),
        v.literal("error"),
        v.literal("done"),
      ),
      message: v.optional(v.string()),
      unlinked: v.optional(v.array(unlinkedEntryValidator)),
      unlinkedTotal: v.optional(v.number()),
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
    return row
      ? {
          status: row.status,
          message: row.message,
          unlinked: row.unlinked,
          unlinkedTotal: row.unlinkedTotal,
        }
      : null;
  },
});

/**
 * Dismiss a finished sync's notice (NEO-211 D).
 *
 * Only ever deletes a row in the `"done"` state. A `"syncing"` row is live
 * state the action owns and an `"error"` row is the column's Retry affordance
 * — letting a stray dismiss remove either would strand the column showing
 * nothing while a sync is in flight, or silently hide a failure.
 */
export const dismissSelectorSyncNotice = mutation({
  args: {
    level: levelValidator,
    parentId: v.optional(v.id("selectorOptions")),
  },
  returns: v.object({ dismissed: v.boolean() }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const row = await ctx.db
      .query("selectorSyncStatus")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", args.level).eq("parentId", args.parentId),
      )
      .first();
    if (!row || row.status !== "done") return { dismissed: false };
    await ctx.db.delete(row._id);
    return { dismissed: true };
  },
});

// ─── NEO-211 C — rename suggestions as DERIVED STATE ────────────────────────
//
// "The marketplace renamed this set" needs no staging table and no pipeline.
// Both stores already record what each marketplace calls the set, in
// `platformLabels[side][primarySlot]`, and neither store has ever written
// `value`. So the whole feature is a query over rows we already have: where
// the stored label differs from NB's name, offer the label; nothing changes
// until an admin accepts.
//
// Derived state is what makes this work identically at every level, with the
// fire-and-forget `ensureSelectorOptions` design, and with two admins in the
// tree at once (NEO-47): there is no queue to get out of sync with the data.

/** Bound on one suggestions page — a column never shows more than this. */
const MAX_SUGGESTIONS = 200;
/** Bound on one apply call. Matches the review modal's page size. */
const MAX_SUGGESTION_DECISIONS = 200;

export const getSelectorSyncSuggestions = query({
  args: {
    level: levelValidator,
    parentId: v.optional(v.id("selectorOptions")),
  },
  returns: v.array(
    v.object({
      existingId: v.id("selectorOptions"),
      currentValue: v.string(),
      suggestions: v.array(
        v.object({
          side: platformSideValidator,
          label: v.string(),
          /**
           * True when the two names differ only in case, punctuation or
           * whitespace — `nameKey`'s fold, the same one NEO-203's content diff
           * uses to separate a reformatting from a rewrite. The modal can
           * de-emphasise these; the matcher's own fold stays lower/trim so
           * that "Gold /50" and "Gold 50" remain two different sets.
           */
          foldEqual: v.boolean(),
        }),
      ),
      /** `lastUpdated` — apply refuses a decision taken against an older row. */
      baseVersion: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    // One indexed sibling read. No ancestor walk: everything this answers is
    // on the row itself, and a column re-runs this query reactively on every
    // change in its own list.
    const siblings = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", args.level).eq("parentId", args.parentId),
      )
      .take(MAX_SUGGESTIONS * 4);

    const out: Array<{
      existingId: Id<"selectorOptions">;
      currentValue: string;
      suggestions: Array<{
        side: "bsc" | "sportlots";
        label: string;
        foldEqual: boolean;
      }>;
      baseVersion: number;
    }> = [];

    for (const row of siblings) {
      if (out.length >= MAX_SUGGESTIONS) break;
      // Never offer an Accept the server would refuse: a non-custom
      // variantType row's value is load-bearing and cannot be renamed at all.
      if (refusesValueRename(row)) continue;

      const suggestions: Array<{
        side: "bsc" | "sportlots";
        label: string;
        foldEqual: boolean;
      }> = [];
      for (const side of PLATFORM_SIDES) {
        const slot = primarySlot(row, side);
        if (!slot) continue;
        const label = row.platformLabels?.[side]?.[slot];
        if (!label) continue;
        const labelKey = selectorValueKey(label);
        if (labelKey === selectorValueKey(row.value)) continue;
        // A label the operator already declined is not news. Stored and
        // compared normalised so a re-cased label does not re-open a decision.
        if (row.declinedUpstreamLabels?.[side] === labelKey) continue;
        suggestions.push({
          side,
          label,
          foldEqual: nameKey(label) === nameKey(row.value),
        });
      }
      if (suggestions.length === 0) continue;
      out.push({
        existingId: row._id,
        currentValue: row.value,
        suggestions,
        baseVersion: row.lastUpdated ?? 0,
      });
    }

    return out;
  },
});

/**
 * Act on suggestions. Fail-closed in every direction:
 *
 *  - the label written is the one the SERVER reads off the row, never a string
 *    the client sent — the args carry no label or value field at all, so a
 *    caller cannot rename a set to anything it likes through this door;
 *  - the target row must be a sibling at (level, parentId), resolved through
 *    the same indexed read the query used, so a decision cannot reach a row
 *    under a different parent;
 *  - `baseVersion` is re-checked against the version each row carried when
 *    this call STARTED, so a decision taken against a row somebody ELSE has
 *    moved since the modal read it is counted, not written. Deliberately not
 *    re-read as the loop writes: a row can disagree with both marketplaces,
 *    and accepting one side while declining the other in one Apply click is
 *    the ordinary case, not a conflict;
 *  - accept goes through the one shared rename path, which re-validates the
 *    stored label, refuses non-custom variantType rows, and clash-checks
 *    against the working set so two accepts folding to one name cannot both
 *    land.
 *
 * Everything refused is COUNTED and returned. Nothing throws over one bad
 * decision — an admin working through 40 rows should not lose 39 of them to
 * the 40th.
 */
export const applySelectorSyncSuggestions = mutation({
  args: {
    level: levelValidator,
    parentId: v.optional(v.id("selectorOptions")),
    decisions: v.array(
      v.object({
        existingId: v.id("selectorOptions"),
        baseVersion: v.number(),
        side: platformSideValidator,
        action: v.union(v.literal("accept"), v.literal("decline")),
      }),
    ),
  },
  returns: v.object({
    applied: v.number(),
    declined: v.number(),
    stale: v.number(),
    clashed: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    if (args.decisions.length > MAX_SUGGESTION_DECISIONS) {
      throw new Error(
        `applySelectorSyncSuggestions: ${args.decisions.length} decisions ` +
          `exceeds the ${MAX_SUGGESTION_DECISIONS}-per-call limit`,
      );
    }

    const siblings = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", args.level).eq("parentId", args.parentId),
      )
      .collect();
    const byId = new Map(siblings.map((r) => [r._id as string, r]));

    // The version each row had when this call STARTED.
    //
    // Staleness means "someone else moved this row since the modal read it",
    // and the only honest baseline for that is the state before we touched
    // anything. Comparing against a version this loop keeps bumping made every
    // second decision on a row read stale — including the accept-one-side +
    // decline-the-other pair the review modal explicitly invites, and even an
    // exact repeat of a decision. That is our own write being reported to the
    // admin as somebody else's concurrent edit.
    const originalVersion = new Map<string, number>(
      siblings.map((r) => [r._id as string, r.lastUpdated ?? 0]),
    );

    // The in-transaction working set. `value` moves as accepts land, and the
    // clash check reads THIS rather than the original snapshot — otherwise two
    // accepts that fold to the same name would both succeed and leave two
    // siblings the pickers cannot tell apart.
    const workingValue = new Map<string, string>(
      siblings.map((r) => [r._id as string, r.value]),
    );
    const workingDeclined = new Map<
      string,
      { bsc?: string; sportlots?: string } | undefined
    >(siblings.map((r) => [r._id as string, r.declinedUpstreamLabels]));
    const workingFeatures = new Map<
      string,
      Record<string, string> | undefined
    >(siblings.map((r) => [r._id as string, r.features]));

    let applied = 0;
    let declined = 0;
    let stale = 0;
    let clashed = 0;
    let skipped = 0;

    for (const decision of args.decisions) {
      const row = byId.get(decision.existingId);
      if (!row) {
        skipped++;
        continue;
      }
      if ((originalVersion.get(row._id) ?? 0) !== decision.baseVersion) {
        stale++;
        continue;
      }

      // The label comes off the row, not off the wire.
      const slot = primarySlot(row, decision.side);
      const label = slot
        ? row.platformLabels?.[decision.side]?.[slot]
        : undefined;
      if (!label) {
        skipped++;
        continue;
      }
      const labelKey = selectorValueKey(label);

      if (decision.action === "decline") {
        const current = workingDeclined.get(row._id);
        if (current?.[decision.side] === labelKey) {
          // Already declined — count it, but do not churn `lastUpdated` and
          // reflow every column watching this row (NEO-85).
          declined++;
          continue;
        }
        const next = { ...(current ?? {}), [decision.side]: labelKey };
        const now = Date.now();
        await ctx.db.patch(row._id, {
          declinedUpstreamLabels: next,
          lastUpdated: now,
        });
        workingDeclined.set(row._id, next);
        declined++;
        continue;
      }

      const plan = planValueRename({
        row: {
          _id: row._id,
          level: row.level,
          value: workingValue.get(row._id) ?? row.value,
          isCustom: row.isCustom,
          features: workingFeatures.get(row._id),
          sportConfig: row.sportConfig,
        },
        nextValue: label,
        siblings: siblings.map((r) => ({
          _id: r._id as string,
          value: workingValue.get(r._id) ?? r.value,
        })),
      });
      if (!plan.ok) {
        if (plan.reason === "clash") clashed++;
        else skipped++;
        continue;
      }
      if (plan.unchanged) {
        skipped++;
        continue;
      }

      // Accepting the label makes any earlier decline of it meaningless.
      const currentDeclined = workingDeclined.get(row._id);
      const cleared = { ...(currentDeclined ?? {}) };
      delete cleared[decision.side];
      const nextDeclined =
        Object.keys(cleared).length > 0 ? cleared : undefined;

      const now = Date.now();
      await ctx.db.patch(row._id, {
        value: plan.value,
        ...(plan.features ? { features: plan.features } : {}),
        ...(plan.sportConfig ? { sportConfig: plan.sportConfig } : {}),
        ...(currentDeclined ? { declinedUpstreamLabels: nextDeclined } : {}),
        lastUpdated: now,
      });
      workingValue.set(row._id, plan.value);
      workingDeclined.set(row._id, nextDeclined);
      if (plan.features) workingFeatures.set(row._id, plan.features);
      applied++;
    }

    // Structured line for the adapter/ops dashboard. Row ids and counts only —
    // no label or display text, which is operator content, not telemetry.
    console.log(
      JSON.stringify({
        msg: "selector_sync_suggestions_applied",
        level: args.level,
        parentId: args.parentId ?? null,
        applied,
        declined,
        stale,
        clashed,
        skipped,
        rowIds: args.decisions.slice(0, 25).map((d) => d.existingId),
      }),
    );

    return { applied, declined, stale, clashed, skipped };
  },
});

// User-safe error surfaced via the reactive selectorSyncStatus.message — the
// raw sync/exception detail goes to console.error only, never into reactive
// state (security audit, NEO-47).
const SYNC_ERROR_MESSAGE = "Couldn't sync options — please try again.";

/**
 * NEO-211 B — what the admin is told when ONE marketplace failed and the other
 * one stored fine.
 *
 * FIXED text per platform, built from the platform NAME only. The adapter's
 * own message can carry a marketplace URL, a response body, or a credential
 * hint, and `selectorSyncStatus.message` is reactive state served to the
 * browser — the same reasoning that made SYNC_ERROR_MESSAGE a constant in
 * NEO-47. The raw detail goes to console.error, joined on requestId.
 */
const PLATFORM_LABELS: Record<string, string> = {
  bsc: "BuySportsCards",
  sportlots: "SportLots",
};

export function partialSyncMessage(failedPlatforms: readonly string[]): string {
  const names = failedPlatforms
    // An unrecognised key is NOT echoed. The only keys this ever receives are
    // "bsc" and "sportlots", but the fallback is what makes that a property of
    // the function rather than of its callers — no adapter string can reach
    // reactive state through here even if a future caller passes one.
    .map((p) => PLATFORM_LABELS[p] ?? "A marketplace")
    .sort()
    .join(" and ");
  return (
    `${names} could not be reached, so nothing from ${names} was changed. ` +
    `Everything the other marketplace returned was saved — retry to fill in the rest.`
  );
}

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
      let res: {
        success: boolean;
        message: string;
        unlinked: UnlinkedEntry[];
        unlinkedTotal: number;
        failedPlatforms: string[];
      };
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
      // NEO-211: three terminal states, not two.
      //
      //   error → the whole sync failed; the column shows Retry (unchanged).
      //   done  → it SUCCEEDED but left a notice: marketplace links removed
      //           because upstream stopped listing them, and/or one platform
      //           unreachable while the other stored fine. Not an error — data
      //           was written, and offering Retry would imply it was not.
      //   clear → success with nothing to say (today's behaviour).
      const hasNotice =
        res.unlinkedTotal > 0 || res.failedPlatforms.length > 0;
      await ctx.runMutation(internal.selectorOptions.setSelectorSyncStatus, {
        level,
        parentId,
        ...(res.success
          ? hasNotice
            ? {
                status: "done" as const,
                ...(res.failedPlatforms.length > 0
                  ? { message: partialSyncMessage(res.failedPlatforms) }
                  : {}),
                ...(res.unlinkedTotal > 0
                  ? {
                      unlinked: res.unlinked,
                      unlinkedTotal: res.unlinkedTotal,
                    }
                  : {}),
              }
            : {}
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

/**
 * What a level sync reports back. `ensureSelectorOptions` turns it into the
 * column's reactive status, so both sync actions return the same shape.
 */
type AggregatedSyncResult = {
  success: boolean;
  message: string;
  optionsCount: number;
  unlinked: UnlinkedEntry[];
  unlinkedTotal: number;
  failedPlatforms: string[];
};

const EMPTY_SYNC_RESULT = {
  optionsCount: 0,
  unlinked: [] as UnlinkedEntry[],
  unlinkedTotal: 0,
  failedPlatforms: [] as string[],
};

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
    /** NEO-211 D — rows whose marketplace link the store removed. */
    unlinked: v.array(unlinkedEntryValidator),
    unlinkedTotal: v.number(),
    /**
     * NEO-211 B — which sides came back with an error. Names only; the caller
     * turns these into fixed user-safe text (`partialSyncMessage`). The raw
     * adapter text never leaves the log.
     */
    failedPlatforms: v.array(v.string()),
  }),
  handler: async (ctx, args): Promise<AggregatedSyncResult> => {
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
            ...EMPTY_SYNC_RESULT,
            success: true,
            message:
              "Custom selector subtree — no marketplace options to aggregate.",
          };
        }

        slPlatformFilters = {};
        bscPlatformFilters = {};

        const BSC_REQUIRED = new Set(["sport", "year", "setName"]);

        for (const ancestor of chain) {
          const lvl = ancestor.level;
          // NEO-137: adapters filter on marketplace IDs and know nothing about
          // slots, so read the ids out of the slot map.
          const slIds = slotIds(ancestor, "sportlots");
          const bscIdsForLevel = slotIds(ancestor, "bsc");
          if (slIds.length > 0) {
            slPlatformFilters[lvl] = slIds[0];
          }
          if (bscIdsForLevel.length > 0) {
            bscPlatformFilters[lvl] = bscIdsForLevel;
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
        return { ...EMPTY_SYNC_RESULT, success: false, message: msg };
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
        // NEO-198: say only what a fired deadline actually knows. A deadline
        // that wins the race gets NO return value from the child, so the
        // aggregator never sees its token_ms / filters_call_ms and cannot tell
        // an auth stall from a marketplace stall — the old wording asserted
        // "stalled before/within the marketplace fetch" and was guessing. The
        // child's adapter_phase(token_ready) breadcrumb, joined on requestId,
        // is what answers that; see recordAdapterPhase in observability.ts.
        platformErrors.sportlots = childDeadlineMessage(
          "SportLots",
          slOutcome.ms,
          requestId,
        );
        console.error(
          `[fetchAggregatedOptions] SportLots child did not return within ${slOutcome.ms}ms deadline (requestId=${requestId}); join adapter_phase on this requestId to attribute auth vs fetch`,
        );
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
        // Same correction as the SportLots branch above — see the note there.
        platformErrors.bsc = childDeadlineMessage(
          "BSC",
          bscOutcome.ms,
          requestId,
        );
        console.error(
          `[fetchAggregatedOptions] BSC child did not return within ${bscOutcome.ms}ms deadline (requestId=${requestId}); join adapter_phase on this requestId to attribute auth vs fetch`,
        );
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
          ...EMPTY_SYNC_RESULT,
          success: false,
          message: `No ${level} options returned from any platform. Check that credentials are configured for BSC and SportLots.`,
          failedPlatforms: Object.keys(platformErrors),
        };
      }

      // 5. Store via mutation.
      //
      // NEO-211 B: `coveredSides` is the sides that actually FETCHED. When
      // SportLots errors and BSC does not, the BSC results are still stored
      // additively — but SL linkage is left alone on every row, because a side
      // that did not answer cannot be evidence that it dropped anything. When
      // both answered, both are covered and a genuinely delisted set has its
      // link removed and reported.
      const coveredSides: Array<"bsc" | "sportlots"> = [];
      if (!platformErrors.bsc) coveredSides.push("bsc");
      if (!platformErrors.sportlots) coveredSides.push("sportlots");

      // …and `returnedIds` comes from the RAW adapter results, not from
      // `deduped`. The dedupe above folds two options with the same normalised
      // name into one entry and keeps only the last id per side, so an id the
      // marketplace really did return can vanish from the list the store sees.
      // Deriving the unlink universe from `deduped` would then read that as
      // "upstream dropped it" and detach a live link.
      const fetchedIds: { bsc: string[]; sportlots: string[] } = {
        bsc: [],
        sportlots: [],
      };
      for (const option of allOptions) {
        const bsc = option.platformData.bsc;
        if (Array.isArray(bsc)) fetchedIds.bsc.push(...bsc);
        else if (bsc) fetchedIds.bsc.push(bsc);
        if (option.platformData.sportlots) {
          fetchedIds.sportlots.push(option.platformData.sportlots);
        }
      }

      const result = await ctx.runMutation(
        api.selectorOptions.storeSelectorOptions,
        {
          level,
          options: deduped,
          parentId,
          coveredSides,
          returnedIds: {
            bsc: [...new Set(fetchedIds.bsc)],
            sportlots: [...new Set(fetchedIds.sportlots)],
          },
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
        unlinked: result.unlinked,
        unlinkedTotal: result.unlinkedTotal,
        failedPlatforms: Object.keys(platformErrors),
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
        ...EMPTY_SYNC_RESULT,
        success: false,
        message: `Failed to fetch options: ${error instanceof Error ? error.message : "Unknown error"}`,
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
    // Same trailing shape as fetchAggregatedOptions so ensureSelectorOptions
    // can drive the column's status from either without a branch.
    optionsCount: v.number(),
    unlinked: v.array(unlinkedEntryValidator),
    unlinkedTotal: v.number(),
    failedPlatforms: v.array(v.string()),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<AggregatedSyncResult & { totalSets: number }> => {
    await requireAdmin(ctx);
    try {
      // 1. Build ancestor chain from yearId to get sport/year values + BSC slugs
      const chain: Array<{
        _id: Id<"selectorOptions">;
        level: Level;
        value: string;
        platformData: {
          bsc?: Record<string, string>;
          sportlots?: Record<string, string>;
        };
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
          ...EMPTY_SYNC_RESULT,
          success: true,
          message: "Custom sport/year — skipping BSC set sync.",
          totalSets: 0,
        };
      }

      const sportAncestor = chain.find((a: { level: string }) => a.level === "sport");
      const yearAncestor = chain.find((a: { level: string }) => a.level === "year");
      if (!sportAncestor || !yearAncestor) {
        return {
          ...EMPTY_SYNC_RESULT,
          success: false,
          message: "Could not resolve sport/year ancestors",
          totalSets: 0,
        };
      }

      // Build BSC filters (sport + year only)
      const bscPlatformFilters: Record<string, string[]> = {};
      const sportBscIds = slotIds(sportAncestor, "bsc");
      const yearBscIds = slotIds(yearAncestor, "bsc");
      if (sportBscIds.length > 0) {
        bscPlatformFilters.sport = sportBscIds;
      } else {
        bscPlatformFilters.sport = [sportAncestor.value.toLowerCase()];
      }
      if (yearBscIds.length > 0) {
        bscPlatformFilters.year = yearBscIds;
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
          ...EMPTY_SYNC_RESULT,
          success: false,
          message: bscResult.message || "No sets returned from BSC",
          totalSets: 0,
          failedPlatforms: ["bsc"],
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

      // 5. Store sets under each manufacturer.
      //
      // NEO-211 condition 6: NO `coveredSides` here, deliberately. BSC returns
      // one flat set list which this action then BUCKETS by manufacturer-name
      // prefix, so each per-bucket store call sees only a slice of what the
      // fetch returned. Declaring BSC covered on a slice would make every set
      // filed under a different manufacturer look delisted and strip its slug.
      // The whole-year unlink belongs to a store call that sees the whole year,
      // which this is not.
      let totalStored = 0;
      const unlinkedAll: UnlinkedEntry[] = [];
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
        unlinkedAll.push(...result.unlinked);
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
        optionsCount: totalStored,
        unlinked: unlinkedAll.slice(0, UNLINK_NOTICE_LIMIT),
        unlinkedTotal: unlinkedAll.length,
        failedPlatforms: [],
      };
    } catch (error) {
      console.error("[syncSetsAcrossManufacturers] Error:", error);
      return {
        ...EMPTY_SYNC_RESULT,
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

/**
 * NEO-189 — merge the SportLots fan-out's per-set results.
 *
 * Two jobs, deliberately separated, because conflating them is the defect this
 * replaces.
 *
 * **Dedup on SportLots' own IDENTITY.** This used to key on `cardNumber`, and
 * SportLots deliberately reuses a card number across variation rows: "#11 Alec
 * Bohm" and "#11 Alec Bohm [ VAR Action Image ]" are different cards sharing
 * the number 11. That is exactly why `platformRef` is the full description
 * (NEO-91) and why `slClaimKey` keys claims on the ref rather than the number.
 * Keying the merge on the number therefore ate every variation on a
 * multi-source row — silently, and only on multi-source rows, because a
 * single-source row never reaches this merge at all. It also starved NEO-189's
 * BSC↔SL variation pairing of its SL side for precisely the split sets this
 * ticket exists for.
 *
 * **Report number collisions without dropping.** A number arriving from two
 * different SL sets is a fact about the mapping the operator built, and they
 * should see it. But the two rows are distinguishable — SportLots gave them
 * different descriptions — so both are kept and offered; the pairing modal is
 * where an operator decides, and dropping one here would pre-empt that with a
 * guess.
 *
 * Extracted as a pure function so it can be tested exhaustively: the fan-out
 * fires its `ctx.runAction` calls concurrently, which convex-test cannot mock
 * reliably (a concurrent first-call races module resolution and one call
 * reaches the unmocked adapter).
 */
export function mergeSlFanOut<
  T extends { cardNumber: string; platformRef?: string; sourceSlSetId?: string },
>(
  perSetResults: T[][],
): {
  cards: T[];
  collisions: Array<{
    cardNumber: string;
    keptSource: string;
    skippedSource: string;
  }>;
} {
  const identity = (c: T) => c.platformRef ?? `#${c.cardNumber}`;
  const dedup = new Map<string, T>();
  const sourceByNumber = new Map<string, string | undefined>();
  const collisions: Array<{
    cardNumber: string;
    keptSource: string;
    skippedSource: string;
  }> = [];

  for (const cards of perSetResults) {
    for (const c of cards) {
      const key = identity(c);
      if (!dedup.has(key)) dedup.set(key, c);
      if (!sourceByNumber.has(c.cardNumber)) {
        sourceByNumber.set(c.cardNumber, c.sourceSlSetId);
        continue;
      }
      const keptSource = sourceByNumber.get(c.cardNumber);
      if (keptSource !== c.sourceSlSetId) {
        collisions.push({
          cardNumber: c.cardNumber,
          keptSource: keptSource ?? "(unattributed)",
          skippedSource: c.sourceSlSetId ?? "(unattributed)",
        });
      }
    }
  }

  return { cards: Array.from(dedup.values()), collisions };
}

/**
 * NEO-189 — one operator-readable sentence for cross-source card-number
 * collisions, or "" when there are none.
 *
 * Names at most three numbers per marketplace. The operator's next action is
 * the same whether two numbers collided or two hundred (look at the two sets
 * and decide whether they should both be attached), so the count carries the
 * signal and the examples make it actionable without swamping the counts the
 * message exists to show.
 *
 * **It says "all rows kept", because that is now true on both sides.** This
 * used to read "kept the first source for …", which was false for SportLots
 * from the day it was written (`mergeSlFanOut` has always reported without
 * dropping) and became false for BSC when its fetch-time dedup came out. A
 * message telling an operator their data was narrowed when it was not is the
 * same defect as narrowing it silently, pointed the other way: either one
 * leaves them with a wrong picture of what is in the checklist.
 */
export function summarizeCollisions(
  collisions: Array<{
    side: "BSC" | "SL";
    cardNumber: string;
    keptSource: string;
    skippedSource: string;
  }>,
): string {
  if (collisions.length === 0) return "";
  const parts: string[] = [];
  for (const side of ["BSC", "SL"] as const) {
    const forSide = collisions.filter((c) => c.side === side);
    if (forSide.length === 0) continue;
    const shown = forSide.slice(0, 3).map((c) => `#${c.cardNumber}`);
    const more = forSide.length - shown.length;
    parts.push(
      `${side}: ${forSide.length} card number(s) in more than one source set ` +
        `(${shown.join(", ")}${more > 0 ? `, +${more} more` : ""})`,
    );
  }
  return ` — all rows kept; ${parts.join("; ")}`;
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
  /** NEO-189: this row is a second version of another card in the same set.
   *  Which one is resolved at commit, not here. */
  isVariation?: boolean;
  // NEO-137: WIRE shape — each ref carries the marketplace SET it came from,
  // so the source travels with the ref instead of in a parallel
  // `sourcePlatformIds` that could drift out of step. Commit resolves `setId`
  // to a slot on the card's own parent row.
  platformData: WirePlatformData;
  /**
   * NEO-199 — the two marketplaces disagree about WHO IS ON this card.
   *
   * Present only on an auto-matched row whose two sides failed
   * `conflictingNames`, which is a fraction of a percent of a set. `cardName`
   * above still carries BSC's answer, exactly as before; this is what the merge
   * used to throw away, kept so the modal can offer the choice instead of
   * presenting a silent winner.
   *
   * Deliberately NOT set on an unmatched row: there is only one name there, and
   * nothing to disagree with.
   */
  nameConflict?: { bsc: string; sportlots: string };
  /**
   * Reconciliation marker for cards that landed on only one side. UI
   * surfaces these as needing human review; reconciled cards (from both
   * sides) carry no such tag.
   */
  unmatched?: "bsc" | "sl";
}

const previewCardFields = {
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
  // NEO-189: the adapter's answer to a DOMAIN question — "is this row a second
  // version of another card in this set?" Each adapter derives it from its own
  // signals (BSC from its `VAR` token / `cardNo` suffix, SportLots from its
  // ` [ VAR … ]` description marker); nothing downstream of here knows or cares
  // which marketplace it came from.
  //
  // The PARENT is not on the wire. It is resolved at commit by
  // `resolveVariationParents`, which groups on the card-number stem and takes
  // the one non-variation row in each group. Sending a parent pointer instead
  // would mean trusting the client to preserve array order or ids it has no
  // reason to preserve.
  isVariation: v.optional(v.boolean()),
  // NEO-137: ref + the marketplace set it came from. Replaces the separate
  // `sourcePlatformIds`, which carried the full set id on every card. This is
  // the WIRE shape — commit resolves `setId` to a slot on the parent row.
  platformData: cardPlatformWireDataValidator,
  // NEO-199 — the losing name from an auto-matched merge, so the modal can flag
  // a disagreement it did not itself create.
  //
  // Widening a strict `v.object` is the point of the change: this validator is
  // what `resolveEntities` and `commitCardChecklist` check on the way to
  // commit, so without it there is no legal way for the second name to reach
  // the client at all. It is OPTIONAL and absent on every agreeing row —
  // roughly 99% of a 908-card set — so the wire cost is paid only where there
  // is something to say.
  //
  // A confirmed card does not carry it: CardPairingModal lifts it onto the PAIR
  // and strips it from the card, so the committed payload is byte-identical to
  // what it was before this field existed. The optionality is what makes that
  // stripping legal rather than a second shape.
  nameConflict: v.optional(
    v.object({ bsc: v.string(), sportlots: v.string() }),
  ),
  unmatched: v.optional(v.union(v.literal("bsc"), v.literal("sl"))),
};

const previewCardValidator = v.object(previewCardFields);

/**
 * NEO-203 — the commit wire shape: a preview card PLUS the operator's decision
 * about what may be written over an existing NeonBinder row.
 *
 * NeonBinder owns its card data; a marketplace exists only to link an NB card
 * back to a marketplace for listing. So a re-sync that MATCHES an existing row
 * refreshes that row's marketplace linkage unconditionally, and writes a
 * content field only when the operator named THAT FIELD in `applyFields`.
 *
 * Per-field rather than per-card because the two decisions are independent:
 * one upstream change adds a missing rookie flag (take it) while another
 * overwrites a carefully spelled card name (leave it), and they arrive on the
 * same card. Names are checked against `NB_CONTENT_FIELDS` server-side and
 * anything unrecognised is dropped, so the list can only narrow what is
 * written.
 *
 * ABSENT or EMPTY is the safe default deliberately: an unreviewed commit —
 * every caller that predates the review UI included, and an older SPA talking
 * to this backend mid-deploy — refreshes linkage and leaves operator edits
 * alone. This fails closed; it is never "write unless told not to".
 *
 * `baseVersion` is the matched row's `lastUpdated` as of the diff the operator
 * was shown, and is required for `applyFields` to have any effect. The chunk
 * re-checks it against the row inside the writing transaction, so a decision
 * made against content that has since changed applies nothing and is reported.
 *
 * Neither field has any effect on the INSERT path. A card that matches no
 * existing row is a new card, and marketplace data is the legitimate bootstrap
 * for one.
 */
const commitCardValidator = v.object({
  ...previewCardFields,
  applyFields: v.optional(v.array(v.string())),
  baseVersion: v.optional(v.number()),
});

/**
 * Action — fetch and reconcile a checklist into pairing CANDIDATES, without
 * persisting a single NB card.
 *
 * Pipeline:
 *   1. Resolve ancestor chain → sport, year, set/variant filters
 *   2. Fetch BSC + SL in parallel; tolerate single-side failure
 *   3. Reconcile by cardNumber (with cardNumberPrefix from selectorOption
 *      metadata applied), then BSC→SL cross-ref via BSC.sportlotsRef,
 *      then Jaro-Winkler ≥ 0.92 fuzzy match on player names
 *   4. PUBLISH the three buckets to `checklistCandidates` (NEO-195), then
 *      enrich them with per-card BSC team names in chunks, releasing each
 *      chunk as it lands
 *
 * The candidates table is the ONLY way the cards reach the client — see the
 * `returns` note below. Entity resolution runs later, on the pairs the
 * operator confirmed (`resolveChecklistEntities`), and persistence later still
 * (`commitCardChecklist`), so nothing is created for a candidate that is about
 * to be discarded.
 */
export const fetchCardChecklist = action({
  args: {
    selectorOptionId: v.id("selectorOptions"),
  },
  /**
   * The cards do NOT come back this way. They are published to
   * `checklistCandidates` as they are reconciled (NEO-195) and the modal reads
   * them from `getReadyCandidates`; this return carries only what the STREAM
   * cannot say.
   *
   * ## Why the payload went away
   *
   * Until now this also returned the whole `{ autoMatched, unmatchedBsc,
   * unmatchedSl }` set at the end, and `CardChecklist` held it as
   * `pendingPairing`. Every row therefore crossed the wire twice — once
   * streamed, once here — and the screen had two sources for one thing.
   *
   * They did not merely cost twice; they DIVERGED. `CardPairingModal` absorbs
   * `initialData` append-only (keyed on marketplace ref, so a decision the
   * operator has already made cannot be disturbed), which means the late
   * payload's rows were all already known and its contents were dropped on the
   * floor — including the team names this action spends ~74s resolving. The
   * second wire was not a safety net, it was a second shape to keep in step:
   * NEO-199 had to widen both, with a test pinning each.
   *
   * ## What is left, and why each piece has to be here
   *
   * `success` / `message` — the sync-status line under the button, including
   * NEO-196's cross-source collision report. Nothing else knows about them.
   *
   * `candidateCount` — the "nothing to pair" signal. A custom subtree
   * short-circuits before any candidate is written, and the client goes
   * straight to entity resolution rather than showing an empty dialog. It
   * cannot read that off the subscription instead: the query's value at the
   * moment this promise resolves may predate the batch write.
   *
   * `sportId` is deliberately NOT here. The client walks the same ancestor
   * chain for its own pickers already (`getAncestorChain`), so returning it
   * was a third copy of a fact the caller can see. Dropping it also makes the
   * Convex-then-SPA deploy window safe: a cached OLD bundle running against
   * this function bails at its own `if (!result.sportId)` guard — message
   * shown, candidates discarded, nothing written — instead of reaching the
   * `nothingToPair` branch with empty arrays, which would commit an empty
   * checklist over a real set.
   */
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    /** Rows published to `checklistCandidates` by this run. 0 = nothing to pair. */
    candidateCount: v.number(),
  }),
  handler: async (ctx, args): Promise<{
    success: boolean;
    message: string;
    candidateCount: number;
  }> => {
    // NEO-202: this was the one function in this file with no identity check.
    // It is not merely a read: it performs authenticated fetches against BSC
    // and SportLots with OUR stored credentials from OUR egress IP, and since
    // NEO-195 it also writes ~900 `checklistCandidates` rows per call. Public
    // and unauthenticated, that is a marketplace-credential abuse primitive
    // and a write amplifier behind one document id.
    //
    // `requireAdmin`, not `requireSignedIn`: `selectorOptions` is the global
    // admin-managed taxonomy and every other entry point onto it — including
    // `commitCardChecklist`, `resolveChecklistEntities` and the
    // `discardCandidates` that reaps this action's own rows — is admin-gated.
    // A signed-in non-admin has no flow that reaches this button.
    //
    // Outside the `try` on purpose: the catch below converts throws into
    // `{ success: false, message }`, which would render an authorization
    // failure as a marketplace outage.
    const adminUserId = await requireAdmin(ctx);
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
      // NEO-96: `sport` used to be `ancestor.value.toLowerCase()` — a BSC wire
      // format — and that string was persisted onto teams/players by
      // commitCardChecklist. It is now the sport ROW's id, which the CLIENT
      // resolves off this same chain (see the `returns` note above); all this
      // handler still needs from the sport row is a label for the log line.
      let sportLabel: string | undefined;
      let cardNumberPrefix: string | undefined;

      for (const ancestor of chain) {
        filters[ancestor.level] = ancestor.value;
        if (ancestor.level === "sport") {
          sportLabel = ancestor.value;
        }
        if (ancestor.metadata?.cardNumberPrefix) {
          cardNumberPrefix = ancestor.metadata.cardNumberPrefix;
        }
        // NEO-137: adapters filter on marketplace IDs; slots are internal.
        const ancestorSlIds = slotIds(ancestor, "sportlots");
        if (ancestorSlIds.length > 0) {
          slPlatformFilters[ancestor.level] = ancestorSlIds;
        }
        // BSC is bucketed by FACET, not by level — see `bscFacetPlan` below.
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
        // No marketplace cards exist for a custom subtree. Its own custom
        // cards can still carry unresolved pendingPlayerNames /
        // pendingTeamNames, but resolving those is now
        // `resolveChecklistEntities`' job (NEO-137) — it runs on the
        // confirmed set and handles the no-marketplace case identically.
        return {
          success: true,
          message:
            "Custom selector subtree — no marketplace data available; add custom cards.",
          // No candidates written at all — the client reads this as "nothing to
          // pair" and goes straight to entity resolution.
          candidateCount: 0,
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
        // NEO-137: check for an actual ID, not truthiness of the slot map —
        // an empty `{}` is truthy and would silently satisfy this precondition.
        if (
          BSC_REQUIRED_LEVELS.has(ancestor.level) &&
          slotIds(ancestor, "bsc").length === 0
        ) {
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
        return { success: false, message: msg, candidateCount: 0 };
      }

      // NEO-189 — bucket the chain's BSC ids by the FACET each one belongs to
      // rather than by the NB level of the row holding it.
      //
      // This is the whole point of the ticket. BSC splits Topps into Series 1
      // and Series 2 at `setName` while SportLots has one set, so a **setName**
      // id has to hang off the NB Base (`variantType`) row — and the old
      // level-keyed bucketing threw those away (`variantType` was skipped,
      // `parallel` had no facet at all). An id now follows what it IS.
      //
      // Untagged slots keep the level rule, so a row attached before this
      // change queries exactly what it queried before.
      const bscFacetPlan = resolveBscFacetFilters(chain);

      console.log(
        `[fetchCardChecklist] sport=${sportLabel} prefix=${cardNumberPrefix}`,
        `filters:`, filters,
        `bscFacets:`, bscFacetPlan.filters,
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
        /** NEO-189 — SL tags a variation in the description and reuses the
         *  parent's card number. */
        isVariation?: boolean;
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

      // NEO-189 — card numbers seen from more than one source set, on either
      // marketplace. Surfaced to the operator in the result message, because
      // two attached sets legitimately overlapping is a fact about the mapping
      // they just built and only they can say whether it was intended. Every
      // row is kept on both sides; this is a report, not a drop.
      const slCollisions: Array<{
        cardNumber: string;
        keptSource: string;
        skippedSource: string;
      }> = [];

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
        const merged = mergeSlFanOut(perIdResults);
        for (const col of merged.collisions) {
          slCollisions.push(col);
          console.warn(
            `[fetchCardChecklist] SL cardNumber in two source sets: ${col.cardNumber} ` +
              `(${col.keptSource} and ${col.skippedSource}) — both rows kept`,
          );
        }
        return merged.cards;
      };

      type BscFetchResult = {
        success: boolean;
        cards: any[];
        message?: string;
        collisions?: Array<{
          cardNumber: string;
          keptSource: string;
          skippedSource: string;
        }>;
      };
      const fetchBsc = async (): Promise<BscFetchResult> => {
        // The adapter fans out internally — one request per BSC source set.
        // BSC does NOT OR multi-value facets: two values on one facet return
        // 200 OK with zero rows (measured on dev 2026-08-12, 1996 Score).
        // The comment that used to be here asserted the opposite.
        //
        // NEO-189: `facetFilters`, not `platformFilters`. The level-keyed form
        // cannot express a setName id attached to a Base row, which is the
        // split this feature exists for.
        return await ctx.runAction(
          api.adapters.buysportscards.fetchBscChecklist,
          {
            parentFilters: filters,
            facetFilters: bscFacetPlan.filters,
            ...(bscFacetPlan.sourceFacet
              ? { sourceFacet: bscFacetPlan.sourceFacet }
              : {}),
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

      const bscCollisions = bscResult.collisions ?? [];
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
        /** NEO-189 — BSC marks a variation with a VAR token and/or a `VAR:`
         *  description, and suffixes the card number. */
        isVariation?: boolean;
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
        // NEO-189: prefer the NON-variation row for a given number.
        //
        // SportLots files a card and its variations under ONE number — "#11
        // Alec Bohm", "#11 Alec Bohm [ VAR Action Image ]", "#11 … [ VAR
        // Throwback Alternate ]". A plain last-write-wins index therefore
        // answered `get("11")` with whichever variation happened to be scraped
        // last, and BSC's base #11 paired with a variation. Wrong, and silent.
        //
        // A bare BSC number means the base card, so that is what this index
        // must return. Variations are paired to variations separately below.
        const prev = slByNumber.get(c.cardNumber);
        if (!prev || (prev.isVariation && !c.isVariation)) {
          slByNumber.set(c.cardNumber, c);
        }
        if (c.sportlotsRef) slByRef.set(c.sportlotsRef, c);
      }

      // NEO-189 — pair BSC variations to SportLots variations of the same card.
      //
      // Neither side's number can do this on its own: BSC suffixes a variation
      // (`1b`), SportLots reuses the parent's number and tags the description.
      // So `slByNumber.get("1b")` finds nothing, the fuzzy name fallback cannot
      // help (the base already claimed that SL row, and a "Legend" variation may
      // be a different player entirely), and every variation lands in the
      // BSC-only column. A real 2025 Topps sync put 393 of them there.
      //
      // Grouped by card-number STEM — the one thing both sides agree on — and
      // matched on the variation label via suggestVariationPairings: exact
      // wording first, then containment ("Action" in "Action Image"). Anything
      // it will not pair confidently is left for the operator rather than
      // guessed, which is the same rule the commit-time parent resolution
      // follows.
      const slVariationPairByBscRef = new Map<string, typeof slCards[0]>();
      {
        const bscVarsByStem = new Map<string, typeof bscCards>();
        for (const c of bscCards) {
          if (!c.isVariation) continue;
          const stem = cardNumberStem(c.cardNumber);
          const b = bscVarsByStem.get(stem);
          if (b) b.push(c);
          else bscVarsByStem.set(stem, [c]);
        }
        const slVarsByStem = new Map<string, typeof slCards>();
        for (const c of slCards) {
          if (!c.isVariation) continue;
          const stem = cardNumberStem(c.cardNumber);
          const b = slVarsByStem.get(stem);
          if (b) b.push(c);
          else slVarsByStem.set(stem, [c]);
        }
        let paired = 0;
        for (const [stem, bscVars] of bscVarsByStem) {
          const slVars = slVarsByStem.get(stem);
          if (!slVars?.length) continue;
          const { pairs } = suggestVariationPairings(
            bscVars.map((c) => c.cardVariation ?? ""),
            slVars.map((c) => c.cardVariation ?? ""),
          );
          for (const pair of pairs) {
            const bscRef = bscVars[pair.leftIndex]?.platformRef;
            const slCard = slVars[pair.rightIndex];
            if (bscRef && slCard) {
              slVariationPairByBscRef.set(bscRef, slCard);
              paired++;
            }
          }
        }
        if (bscVarsByStem.size > 0) {
          console.log(
            JSON.stringify({
              msg: "variation_pairing",
              bscVariations: [...bscVarsByStem.values()].reduce((n, v) => n + v.length, 0),
              slVariations: [...slVarsByStem.values()].reduce((n, v) => n + v.length, 0),
              paired,
            }),
          );
        }
      }

      // NEO-137 — STICKY PAIRING. An operator's confirmed pairing must survive
      // a re-sync, otherwise a shared marketplace set has to be hand-paired
      // again on every fetch and the assignment is not really persisted.
      //
      // Re-deriving from scratch is not good enough: the whole point of this
      // ticket is that the BSC↔SL pairing is NOT inferable (two series can each
      // contain a card #1), so a fresh guess would silently overwrite the
      // operator's answer with the wrong one.
      //
      // Already-committed rows carry the answer in platformData.{bsc,sportlots}.
      // Index the SL ref an operator previously bound to each BSC ref and
      // honour it ahead of every heuristic below.
      const committed = await ctx.runQuery(
        api.selectorOptions.getCardChecklist,
        { selectorOptionId: args.selectorOptionId },
      );
      const storedSlRefByBscRef = new Map<string, string>();
      const storedSlRefs = new Set<string>();
      for (const row of committed) {
        const bscRef = row.platformData?.bsc?.ref;
        const slRef = row.platformData?.sportlots?.ref;
        if (slRef) storedSlRefs.add(slRef);
        if (bscRef && slRef) storedSlRefByBscRef.set(bscRef, slRef);
      }
      const slByPlatformRef = new Map<string, typeof slCards[0]>();
      // INDISTINGUISHABLE (NEO-137 accounting): two SportLots rows sharing BOTH
      // card number and description. SL exposes no per-card id, so the
      // description IS the identity (NEO-91) — when it collides there is
      // genuinely nothing left to tell the rows apart except ordinal position
      // in the scrape, which is not stable across re-scrapes. Report it; do
      // NOT guess, because a wrong guess here silently binds a card to the
      // wrong marketplace row and looks identical to a correct one.
      const indistinguishableSlRefs: string[] = [];
      for (const c of slCards) {
        if (!c.platformRef) continue;
        if (slByPlatformRef.has(c.platformRef)) {
          indistinguishableSlRefs.push(c.platformRef);
          continue; // first occurrence wins; the duplicate is reported, not used
        }
        slByPlatformRef.set(c.platformRef, c);
      }
      if (indistinguishableSlRefs.length > 0) {
        console.warn(
          `[fetchCardChecklist] ${indistinguishableSlRefs.length} SportLots row(s) ` +
            `are indistinguishable (same card number AND description) — only ` +
            `ordinal position separates them and that is not stable. Not guessed: ` +
            indistinguishableSlRefs.slice(0, 5).join(" | "),
        );
      }
      // A stored ref that no longer appears in the marketplace's response is
      // ORPHANED — SportLots edited the description out from under us. Report
      // it; never silently drop the card it belonged to.
      const orphanedSlRefs = [...storedSlRefs].filter(
        (ref) => !slByPlatformRef.has(ref),
      );
      if (orphanedSlRefs.length > 0) {
        console.warn(
          `[fetchCardChecklist] ${orphanedSlRefs.length} stored SportLots ref(s) ` +
            `no longer resolve — the marketplace changed the description: ` +
            orphanedSlRefs.slice(0, 5).join(" | "),
        );
      }

      // NEO-137: three buckets, not one flat list. No NB card exists until
      // the operator pairs — same vocabulary as set reconciliation (matched /
      // unmatched-BSC / unmatched-SL) and the same keep shelf for a
      // deliberately-single-sided card.
      //
      // This is also what holds a shared SL set's sibling-owned cards: when
      // two NB rows draw from one SL set, the other row's cards simply land
      // in unmatchedSl and are dropped unless the operator keeps them, rather
      // than being materialised as bogus cards under this row.
      const autoMatchedCards: Array<{
        card: ReconciledCard;
        confidence: number;
      }> = [];
      const unmatchedBscCards: ReconciledCard[] = [];
      const unmatchedSlCards: ReconciledCard[] = [];
      // `out` stays as the union of everything, purely so the team-lookup and
      // entity-bucketing passes below can walk every candidate once.
      const out: ReconciledCard[] = [];
      // NEO-189: claims are keyed by SL's REAL identity — its platformRef, the
      // full row description — not by card number.
      //
      // SportLots deliberately reuses a card number across variation rows:
      // "#11 Alec Bohm" and "#11 Alec Bohm [ VAR Action Image ]" are different
      // cards sharing the number 11. That is precisely why platformRef is the
      // description (NEO-91).
      //
      // Keying claims by NUMBER meant the first BSC card to claim SL's "#11"
      // marked every other SL row numbered 11 as taken. Its variations were
      // then invisible on both sides — not matched, and skipped by the
      // leftover loop that builds unmatchedSl — so they vanished silently.
      // A real 2025 Topps sync reported "350 paired, 393 BSC-only, 0 SL-only":
      // the zero was not "SportLots had nothing extra", it was the variations
      // being discarded.
      //
      // Falls back to the number only when a row has no ref, which is the one
      // case where nothing better exists.
      const claimedSlRefs = new Set<string>();
      const slClaimKey = (c: { platformRef?: string; cardNumber: string }) =>
        c.platformRef ?? `#${c.cardNumber}`;

      // 1. Walk BSC, attach matching SL data
      for (const bsc of bscCards) {
        const stripped = cardNumberPrefix && bsc.cardNumber.startsWith(cardNumberPrefix)
          ? bsc.cardNumber.slice(cardNumberPrefix.length)
          : bsc.cardNumber;

        // Operator's stored answer first — it outranks every heuristic.
        const storedSlRef = bsc.platformRef
          ? storedSlRefByBscRef.get(bsc.platformRef)
          : undefined;
        let sl: typeof slCards[0] | undefined =
          (storedSlRef && slByPlatformRef.get(storedSlRef))
          || (bsc.sportlotsRef && slByRef.get(bsc.sportlotsRef))
          // NEO-189: a variation's counterpart, matched by label above. Ranks
          // below the operator's stored answer and BSC's own cross-reference,
          // and above the number lookups — which cannot resolve a suffixed
          // number against SportLots at all.
          || (bsc.platformRef ? slVariationPairByBscRef.get(bsc.platformRef) : undefined)
          || slByNumber.get(bsc.cardNumber)
          || slByNumber.get(stripped);
        const fromStoredPairing =
          storedSlRef !== undefined && slByPlatformRef.has(storedSlRef);

        // 2. Fuzzy fallback: pick the unclaimed SL card whose first player
        //    name is most similar to BSC's first player. Threshold 0.92.
        let fuzzyScore: number | undefined;
        if (!sl && bsc.players?.[0]) {
          const target = normalizeName(bsc.players[0]);
          let best: { card: typeof slCards[0]; score: number } | null = null;
          for (const candidate of slCards) {
            if (claimedSlRefs.has(slClaimKey(candidate))) continue;
            const candName = candidate.cardName ? normalizeName(candidate.cardName) : "";
            if (!candName) continue;
            const score = jaroWinkler(target, candName);
            if (score >= 0.92 && (!best || score > best.score)) {
              best = { card: candidate, score };
            }
          }
          if (best) {
            sl = best.card;
            fuzzyScore = best.score;
          }
        }

        // Confidence: an exact number / sportlotsRef hit is certain; a
        // Jaro-Winkler name match is not. Surfaced so the operator can see
        // which pairings deserve a second look.
        // A previously-confirmed pairing is certain by definition — it is the
        // operator's own answer being replayed, not a guess.
        const pairConfidence = sl ? (fromStoredPairing ? 1 : (fuzzyScore ?? 1)) : 0;
        if (sl) claimedSlRefs.add(slClaimKey(sl));

        const attributes = Array.from(new Set([
          ...(bsc.attributes ?? []),
          ...(sl?.attributes ?? []),
        ]));
        const printRun = bsc.printRun ?? sl?.printRun;
        const players = bsc.players ?? (sl?.players ?? undefined);
        const teamsArr = bsc.teams ?? (sl?.teams ?? undefined);

        // NEO-199 — recorded BEFORE the merge below throws one of the two
        // names away.
        //
        // This is the COMMON path: most of a 660-row set auto-matches here and
        // never reaches the operator's hands, so a wrong-player guard that only
        // fires on the manual leftovers is a guard that mostly does not fire —
        // worse than none, because the screen then looks like it is protecting
        // you. `cardName` below still resolves to BSC exactly as before; the
        // only change is that the loser survives the trip.
        const nameConflict = sl
          ? conflictingNames(bsc.cardName, sl.cardName)
          : undefined;

        const candidate: ReconciledCard = {
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
          cardVariation: bsc.cardVariation ?? sl?.cardVariation,
          // NEO-189: EITHER source recognising a variation makes it one. They
          // mark it differently (BSC suffixes the number, SL tags the
          // description) and one may carry a variation the other has not
          // catalogued, so this is a union rather than a preference.
          isVariation: bsc.isVariation || sl?.isVariation || undefined,
          // NEO-137: each ref carries the marketplace SET it came from, so
          // the source travels with the ref rather than in a parallel
          // `sourcePlatformIds` object that could fall out of step with it.
          // Commit resolves `setId` to a slot on this card's parent row.
          platformData: {
            ...(bsc.platformRef
              ? {
                  bsc: {
                    ref: bsc.platformRef,
                    ...(bsc.sourceBscSetSlug
                      ? { setId: bsc.sourceBscSetSlug }
                      : {}),
                  },
                }
              : {}),
            ...(sl?.platformRef
              ? {
                  sportlots: {
                    ref: sl.platformRef,
                    ...(sl.sourceSlSetId ? { setId: sl.sourceSlSetId } : {}),
                  },
                }
              : {}),
          },
          // Spread rather than always-present-and-undefined: `previewCardValidator`
          // is strict, and an explicit `undefined` is not the same as an absent
          // optional on the wire.
          ...(nameConflict ? { nameConflict } : {}),
          ...(sl ? {} : { unmatched: "sl" as const }),
        };
        out.push(candidate);
        if (sl) autoMatchedCards.push({ card: candidate, confidence: pairConfidence });
        else unmatchedBscCards.push(candidate);
      }

      // 3. SL cards no BSC card claimed. These are NOT turned into NB cards
      //    on their own any more — they are offered for the operator to pair
      //    or deliberately keep.
      for (const sl of slCards) {
        if (claimedSlRefs.has(slClaimKey(sl))) continue;
        const slOnly: ReconciledCard = {
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
          cardVariation: sl.cardVariation,
          isVariation: sl.isVariation,
          platformData: sl.platformRef
            ? {
                sportlots: {
                  ref: sl.platformRef,
                  ...(sl.sourceSlSetId ? { setId: sl.sourceSlSetId } : {}),
                },
              }
            : {},
          unmatched: "bsc",
        };
        out.push(slOnly);
        unmatchedSlCards.push(slOnly);
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

      // NEO-195 — publish the reconciled candidates NOW, before the team
      // lookup, so the modal can start filling in at ~6s instead of ~80s.
      //
      // Every row goes in as `pending` when a lookup is outstanding; the chunk
      // loop below flips each to `ready` as its team lands. `status` reports
      // enrichment progress, it does not gate visibility — pairing needs card
      // numbers and descriptions, not teams, and Confirm is separately blocked
      // until the whole fetch finishes (see checklistCandidates.ts).
      //
      // This is the ONLY copy that reaches the client. The action used to
      // return the same three buckets again at the end; that second wire is
      // gone (see the `returns` note at the top of this action).
      const candidateBatchId = crypto.randomUUID();
      // NEO-202: was `(await getCurrentUserId(ctx)) ?? "unknown"`. The fallback
      // only made sense while the action was anonymous-callable — and it was
      // actively harmful: every anonymous run shared the literal owner
      // "unknown", so `startCandidateBatch`'s per-operator clear made those
      // runs delete each other's rows. `requireAdmin` above already returned
      // the caller's id; there is no unowned batch any more.
      const toCandidate = (
        card: ReconciledCard,
        bucket: "matched" | "bscOnly" | "slOnly",
        confidence?: number,
      ) => ({
        cardNumber: card.cardNumber,
        cardName: card.cardName,
        teams: card.teams,
        players: card.players,
        attributes: card.attributes,
        isRookie: card.isRookie,
        isRelic: card.isRelic,
        printRun: card.printRun,
        autographType: card.autographType,
        cardVariation: card.cardVariation,
        isVariation: card.isVariation,
        platformData: card.platformData,
        // NEO-199: the streamed path is the only path. A conflict missing here
        // is a conflict the operator never sees.
        nameConflict: card.nameConflict,
        bucket,
        confidence,
      });
      await ctx.runMutation(
        internal.checklistCandidates.startCandidateBatch,
        {
          selectorOptionId: args.selectorOptionId,
          batchId: candidateBatchId,
          userId: adminUserId,
          candidates: [
            ...autoMatchedCards.map((m) =>
              toCandidate(m.card, "matched", m.confidence),
            ),
            ...unmatchedBscCards.map((c) => toCandidate(c, "bscOnly")),
            ...unmatchedSlCards.map((c) => toCandidate(c, "slOnly")),
          ],
          readyImmediately: needsTeamLookup.length === 0,
        },
      );

      if (needsTeamLookup.length > 0) {
        // Chunked, so each chunk's results reach the modal as they resolve
        // rather than all at once when the last card returns. The chunk is
        // deliberately a multiple of BSC_TEAM_LOOKUP_CONCURRENCY so each round
        // trip still saturates the fan-out.
        const TEAM_LOOKUP_CHUNK = 50;
        for (let i = 0; i < needsTeamLookup.length; i += TEAM_LOOKUP_CHUNK) {
          const chunk = needsTeamLookup.slice(i, i + TEAM_LOOKUP_CHUNK);
          const teamNames: Record<string, string> = await ctx.runAction(
            internal.adapters.buysportscards.fetchBscCardTeamNames,
            { bscCardIds: chunk.map((c) => c.platformData.bsc!.ref) },
          );
          for (const c of chunk) {
            const name = teamNames[c.platformData.bsc!.ref];
            if (name) c.teams = [name];
          }
          await ctx.runMutation(
            internal.checklistCandidates.resolveCandidateTeams,
            {
              batchId: candidateBatchId,
              resolved: chunk.map((c) => ({
                bscRef: c.platformData.bsc!.ref,
                teamName: teamNames[c.platformData.bsc!.ref],
              })),
            },
          );
        }
      }

      // 5. NEO-137: entity resolution NO LONGER happens here.
      //    Nothing is an NB card yet — the operator has not paired. Creating
      //    players and teams for candidates they are about to discard would
      //    be work done on data that may never exist, and the user asked for
      //    pairing to come before the Wikidata / player / team syncs.
      //    `resolveChecklistEntities` runs on the CONFIRMED set instead.
      console.log(
        `[fetchCardChecklist] ${autoMatchedCards.length} paired, ` +
          `${unmatchedBscCards.length} BSC-only, ${unmatchedSlCards.length} SL-only`,
      );

      // NEO-189 — tell the OPERATOR about cross-source card-number collisions,
      // not just the server log.
      //
      // The console warning was enough while a collision meant "our fan-out is
      // probably misconfigured". Now that a row can deliberately draw from two
      // sets on either marketplace, an overlap is a legitimate outcome the
      // operator chose — and the one thing they cannot see from the checklist
      // itself is that #11 arrived from BOTH attached sets and now appears
      // twice. `message` already renders under the Sync button, so this needs
      // no new surface; it is capped so a badly overlapping pair cannot push
      // the counts off the screen.
      //
      // SURFACING, NOT NARROWING. Neither marketplace drops a row to make the
      // numbers unique. A checklist quietly halved because two attached series
      // both start at #1 looks exactly like a correct one — that is how the
      // BSC dedup reached production, and reverting it is why 1996 Score
      // reconciles to 220 again rather than 110.
      const collisionNote = summarizeCollisions([
        ...bscCollisions.map((c) => ({ ...c, side: "BSC" as const })),
        ...slCollisions.map((c) => ({ ...c, side: "SL" as const })),
      ]);

      return {
        success: true,
        message:
          `${autoMatchedCards.length} matched, ` +
          `${unmatchedBscCards.length} BSC-only, ${unmatchedSlCards.length} SL-only` +
          collisionNote,
        // The cards themselves are already in `checklistCandidates` — this is
        // the count of what was published there, not a second copy of it.
        candidateCount:
          autoMatchedCards.length +
          unmatchedBscCards.length +
          unmatchedSlCards.length,
      };
    } catch (error) {
      console.error(`[fetchCardChecklist] Error:`, error);
      return {
        success: false,
        message: `Failed to fetch checklist: ${error instanceof Error ? error.message : "Unknown error"}`,
        // A throw can land after `startCandidateBatch` has written rows. The
        // count is what THIS call is handing the operator, and a failed call
        // hands them nothing — the client discards the batch on `!success`.
        candidateCount: 0,
      };
    }
  },
});

/**
 * Action — NEO-137: resolve player/team unknowns for the CONFIRMED card set.
 *
 * This used to be step 5 of `fetchCardChecklist`. It moved out because
 * nothing fetched is an NB card until the operator has paired: bucketing
 * names from candidates they are about to discard would create players and
 * teams for cards that never exist, and the operator asked for pairing to
 * happen before the Wikidata / player / team syncs.
 *
 * Callers pass the cards they actually intend to commit (confirmed pairs plus
 * anything held on the keep shelf). Also covers the custom-subtree case,
 * where there are no marketplace cards at all but the row's own custom cards
 * can still carry unresolved pendingPlayerNames / pendingTeamNames.
 */
export const resolveChecklistEntities = action({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    sportId: v.id("selectorOptions"),
    cards: v.array(previewCardValidator),
  },
  returns: v.object({
    unknownPlayers: v.array(v.string()),
    unknownTeams: v.array(v.string()),
    // Present whenever there are unknowns — the review wizard subscribes to
    // this batch via entityReviewQueue.
    batchId: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{
    unknownPlayers: string[];
    unknownTeams: string[];
    batchId?: string;
  }> => {
    await requireAdmin(ctx);
    assertCardBatchWithinLimits(args.cards, "resolveChecklistEntities");

    // `sportId` used to be derived server-side inside fetchCardChecklist; it
    // now round-trips through the browser, so it must be re-validated rather
    // than trusted. A wrong id would bucket every name against the wrong
    // sport (making them all look unknown) and stamp review rows with a row
    // that has no sportConfig, silently disabling Wikidata enrichment.
    const chainForSport = await ctx.runQuery(
      api.selectorOptions.getAncestorChain,
      { id: args.selectorOptionId },
    );
    const sportAncestor = chainForSport.find((a) => a.level === "sport");
    if (!sportAncestor || sportAncestor._id !== args.sportId) {
      throw new Error(
        "resolveChecklistEntities: sportId is not the sport ancestor of selectorOptionId",
      );
    }

    // Deduped by NORMALIZED name inside resolveUnknownsAndStartBatch — two
    // spellings of one player ("Ken Griffey Jr." vs "Ken Griffey Jr") must
    // not produce two unknowns and two Wikidata lookups.
    const additionalPlayerNames: string[] = [];
    const additionalTeamNames: string[] = [];
    for (const c of args.cards) {
      for (const p of c.players ?? []) additionalPlayerNames.push(p);
      for (const t of c.teams ?? []) additionalTeamNames.push(t);
      if (c.team && !c.teams?.length) additionalTeamNames.push(c.team);
    }

    const sportRow = await ctx.runQuery(
      api.selectorOptions.getSelectorOptionById,
      { id: args.sportId },
    );

    return await resolveUnknownsAndStartBatch(ctx, {
      selectorOptionId: args.selectorOptionId,
      sportId: args.sportId,
      sportLabel: sportRow?.value ?? "",
      additionalPlayerNames,
      additionalTeamNames,
    });
  },
});
/**
 * NEO-189 — how many cards one `commitCardChecklistChunk` transaction upserts.
 *
 * Measured, not guessed. The single-mutation version of this commit passed at
 * 335 cards (the E2E `setup.yaml` save — and already sat near its 120s wait)
 * and FAILED at 712 with Convex's `Your request timed out performing too many
 * system operations.` (PR #205 preview, request af06962bc3db7994). Each card
 * costs ~5-6 database operations in the chunk below, so 150 cards is ~900
 * operations per transaction — well inside the budget that 335 cards (~1800)
 * was straining, leaving room for the chunk's fixed cost (one parent-row read
 * plus at most one checklist read).
 *
 * Exported so tests can commit a deliberately multi-chunk batch without
 * hard-coding the number.
 */
export const CARDS_PER_COMMIT_CHUNK = 150;

/**
 * NEO-203 — hard ceiling on how many rows one commit may be told to delete.
 *
 * Mirrors `MAX_CROSS_LISTING_CARD_NUMBERS` above and exists for the same
 * reason: a client-side cap is advisory, and a direct API call must not be
 * able to hand a single transaction an unbounded delete list. Deletion is now
 * an explicit operator decision (see `commitCardChecklistFinalize`), and an
 * operator confirming a thousand deletions in one pass is already far beyond
 * anything the review UI produces.
 */
export const MAX_OPERATOR_DELETE_IDS = 1000;

/**
 * The stored-row shape `buildMatchMaps` needs. Deliberately narrower than
 * `Doc<"cardChecklist">` so a read-only caller can hand it a projection.
 */
type MatchMapRow = {
  _id: Id<"cardChecklist">;
  cardNumber: string;
  platformData?: Doc<"cardChecklist">["platformData"];
};

/** Exactly the half of `CommitPrelude` that `resolveExistingIds` consumes. */
type MatchMaps = {
  existingIdByBscRef: Array<{ ref: string; id: Id<"cardChecklist"> }>;
  existingIdBySlRef: Array<{ ref: string; id: Id<"cardChecklist"> }>;
  existingIdBySlotNumber: Array<{ key: string; id: Id<"cardChecklist"> }>;
  existingIdByNumberNoRef: Array<{
    cardNumber: string;
    id: Id<"cardChecklist">;
  }>;
  ambiguousMatchKeys: string[];
  slotBySetId: Array<{ side: MatchSide; setId: string; slot: string }>;
};

/**
 * The keys `buildMatchMaps` WITHHELD, raw and per tier.
 *
 * Distinct from `MatchMaps.ambiguousMatchKeys`, which is a flat array of
 * `label:truncated-key` strings built for a LOG LINE — a SportLots ref is the
 * whole card description, so what goes to a log is bounded. These sets are the
 * untruncated originals, kept in-process so `resolveExistingIds` can answer a
 * question the log form cannot: did any of this actually change an incoming
 * card's outcome?
 *
 * That distinction is the whole point (CI round 2). Re-syncing 1996 Score
 * Dugout Collection withheld 110 `slotNumber` keys — one SportLots set holds
 * both series, so `(side, slot, number)` repeats by design — and the review
 * screen announced "110 match keys are held by more than one card, so those
 * cards are treated as new" directly above "0 new". Every card had matched at
 * the ref tier; the fallback tiers were never consulted. The count was true and
 * the sentence was false, on exactly the duplicate-numbered sets this feature
 * exists to serve.
 */
type WithheldMatchKeys = {
  bscRef: Set<string>;
  slRef: Set<string>;
  slotNumber: Set<string>;
  numberNoRef: Set<string>;
};

/**
 * NEO-203 — build the four match maps from a checklist snapshot.
 *
 * ## Why this is its own function
 *
 * TWO callers, and they must never disagree: `commitCardChecklistPrelude`
 * (which WRITES) and `diffChecklistAgainstExisting` (the read-only review the
 * operator is shown before that write). If the review resolved matches by one
 * rule and the commit by another, the operator would be accepting a diff
 * against a row the commit then declines to touch — which is precisely the
 * "silent, count-preserving corruption" this ticket exists to remove, wearing
 * a review UI. So the map-building lives here, `resolveExistingIds` is already
 * pure, and the two phases share both. Do NOT inline either back into a
 * caller.
 *
 * Pure and read-only: it takes a snapshot and a leaf node, and touches no
 * database. The snapshot must be the `by_selector_option` collect for the row
 * being synced — every map here is per-selectorOption and per-side, never
 * global.
 *
 * ## The rule, in one line
 *
 * Every tier, refs included, is exactly-one-or-nothing. This used to be one
 * map, cardNumber → id, last row with a given number wins. Card numbers are
 * not unique at ANY scope — not across the source sets a variant fans out to,
 * and not even within one set (a 2025 release ships a veteran #1 and a rookie
 * #1, two distinct cards that are not variations of each other) — so that key
 * silently merged unrelated cards on every re-sync: one row patched twice,
 * another left stale, the row count unchanged.
 *
 * What identifies a marketplace row is its REF, which is what the rest of this
 * codebase already links on (NEO-137's `platformData`). The number-based tiers
 * survive the one case a ref cannot — SportLots' ref IS the card description
 * (NEO-91), so an upstream description fix changes it — and they are guarded
 * so hard that they match only when the answer is unarguable.
 *
 * Two stored rows carrying one ref is already-corrupt data — very likely this
 * bug's own residue, and duplicate SportLots refs occur upstream too (SL's ref
 * IS the description, so two identically-described cards are genuinely
 * indistinguishable; the fetch path reports those as `indistinguishableSlRefs`).
 * Picking one of the two is the silent merge this ticket removes, so the key is
 * withheld and reported in `ambiguousMatchKeys` instead.
 */
function buildMatchMaps(
  existingCards: MatchMapRow[],
  leafNode: Doc<"selectorOptions"> | null,
): { maps: MatchMaps; withheld: WithheldMatchKeys } {
  const byBscRef = new Map<string, Array<Id<"cardChecklist">>>();
  const bySlRef = new Map<string, Array<Id<"cardChecklist">>>();
  const bySlotNumber = new Map<string, Array<Id<"cardChecklist">>>();
  const byNumberNoRef = new Map<string, Array<Id<"cardChecklist">>>();
  const push = (
    m: Map<string, Array<Id<"cardChecklist">>>,
    k: string,
    id: Id<"cardChecklist">,
  ) => {
    const bucket = m.get(k);
    if (bucket) bucket.push(id);
    else m.set(k, [id]);
  };
  for (const row of existingCards) {
    const bscRef = row.platformData?.bsc?.ref;
    const slRef = row.platformData?.sportlots?.ref;
    if (bscRef) push(byBscRef, bscRef, row._id);
    if (slRef) push(bySlRef, slRef, row._id);
    for (const side of MATCH_SIDES) {
      const src = row.platformData?.[side]?.src;
      if (src) {
        push(bySlotNumber, slotNumberMatchKey(side, src, row.cardNumber), row._id);
      }
    }
    if (!bscRef && !slRef) push(byNumberNoRef, row.cardNumber, row._id);
  }

  const ambiguousMatchKeys: string[] = [];
  const withheld: WithheldMatchKeys = {
    bscRef: new Set(),
    slRef: new Set(),
    slotNumber: new Set(),
    numberNoRef: new Set(),
  };
  // Exactly-one or nothing, on every tier. A key several rows hold is withheld
  // from the map and reported instead — the action logs the report, so "this
  // card was treated as new" always has a visible reason.
  //
  // Ref keys are TRUNCATED in the REPORT: a SportLots ref is the card
  // description, unbounded upstream text, and that string goes to a log. The
  // `withheld` sets keep the key verbatim, because they are compared against
  // incoming keys in-process and a truncated key would silently stop matching.
  const unambiguous = (
    m: Map<string, Array<Id<"cardChecklist">>>,
    label: keyof WithheldMatchKeys,
  ): Array<[string, Id<"cardChecklist">]> => {
    const out: Array<[string, Id<"cardChecklist">]> = [];
    for (const [key, ids] of m) {
      if (ids.length === 1) {
        out.push([key, ids[0]]);
      } else {
        ambiguousMatchKeys.push(`${label}:${truncateForLog(key)}`);
        withheld[label].add(key);
      }
    }
    return out;
  };

  const existingIdByBscRef = unambiguous(byBscRef, "bscRef");
  const existingIdBySlRef = unambiguous(bySlRef, "slRef");
  const existingIdBySlotNumber = unambiguous(bySlotNumber, "slotNumber");
  const existingIdByNumberNoRef = unambiguous(byNumberNoRef, "numberNoRef");

  // The parent row's ATTACHED marketplace sets. Read off the SAME node
  // `resolveCardSlots` reads, so the key the cascade builds for an incoming
  // card and the key built here for a stored one describe the same slot. Never
  // allocates — an unattached source set simply yields no slot, and a card from
  // it skips tier 2 entirely.
  const slotBySetId: Array<{ side: MatchSide; setId: string; slot: string }> =
    [];
  if (leafNode) {
    for (const side of MATCH_SIDES) {
      for (const { slot, id } of slotEntries(leafNode, side)) {
        slotBySetId.push({ side, setId: id, slot });
      }
    }
  }

  return {
    maps: {
      existingIdByBscRef: existingIdByBscRef.map(([ref, id]) => ({ ref, id })),
      existingIdBySlRef: existingIdBySlRef.map(([ref, id]) => ({ ref, id })),
      existingIdBySlotNumber: existingIdBySlotNumber.map(([key, id]) => ({
        key,
        id,
      })),
      existingIdByNumberNoRef: existingIdByNumberNoRef.map(
        ([cardNumber, id]) => ({ cardNumber, id }),
      ),
      ambiguousMatchKeys,
      slotBySetId,
    },
    withheld,
  };
}

/**
 * NEO-92/NEO-189 — the once-per-commit half of `commitCardChecklist`.
 *
 * Everything here is per-COMMIT, not per-card, so it runs exactly once no
 * matter how many chunks follow: the admin check, the sport row, the
 * player/team creation driven by the review-queue decisions, the leaf node's
 * feature snapshot, the setName ancestor walk, and the pre-commit snapshot of
 * the checklist that the upsert keys against.
 *
 * COST NOTE: this phase is O(distinct player names + distinct team names) index
 * reads, not O(cards) — one `by_name_normalized_and_sport_id` lookup per
 * distinct name. At 712 cards that is ~1400 reads, comfortably inside the 4096
 * index-range limit. It is the next thing that would need chunking if
 * `MAX_CARDS_PER_COMMIT` were ever actually approached; see the note there.
 */
export const commitCardChecklistPrelude = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    sportId: v.id("selectorOptions"),
    // Just the NAMES off the incoming cards — the prelude never needs the
    // cards themselves, and shipping 700 full card objects into a phase that
    // only reads names off them is pure wire cost.
    playerNames: v.array(v.string()),
    teamNames: v.array(v.string()),
    batchId: v.optional(v.string()),
  },
  returns: v.object({
    userId: v.string(),
    sportSkuCode: v.optional(v.string()),
    sportValue: v.string(),
    playerIdByName: v.array(
      v.object({ name: v.string(), id: v.id("players") }),
    ),
    teamIdByName: v.array(v.object({ name: v.string(), id: v.id("teams") })),
    // Canonical stored name per resolved player id. The old single mutation
    // re-read every player with a `db.get` inside the per-card write loop just
    // to spell its name for the listing title / signedBy default; resolving it
    // once here removes one database operation per player per card.
    playerNameById: v.array(
      v.object({ id: v.id("players"), name: v.string() }),
    ),
    // NEO-101: the same trick one table over. Listing titles now carry the
    // card's TEAM names, and resolving them per card in the chunk would be one
    // `db.get` per team per card — the exact cost `playerNameById` exists to
    // avoid. A commit's whole team vocabulary is a handful of rows; a commit's
    // cards are hundreds.
    teamNameById: v.array(v.object({ id: v.id("teams"), name: v.string() })),
    createdPlayerIds: v.array(v.id("players")),
    createdTeamIds: v.array(v.id("teams")),
    enrichmentTeamIds: v.array(v.id("teams")),
    reviewRowIds: v.array(v.id("entityReviewQueue")),
    // NEO-212: names this commit recorded in `entityReviewSkips`, split by
    // kind. Returned rather than re-derived because the finalize phase, which
    // retires custom cards' pending* entries, cannot see the batch's review
    // rows — they are read here and deleted there.
    skippedPlayerNames: v.array(v.string()),
    skippedTeamNames: v.array(v.string()),
    inheritedFeatures: v.optional(v.record(v.string(), v.string())),
    setNameAncestorId: v.optional(v.id("selectorOptions")),
    setNameValue: v.optional(v.string()),
    existingCustomCardNumbers: v.array(v.string()),
    // ── NEO-203: the match maps, all four resolved ONCE against the
    // pre-commit state of the checklist — and built ONLY over this
    // selectorOption's `by_selector_option` snapshot, never globally. See
    // `resolveExistingIds` for the cascade that consumes them and
    // `commitCardChecklistChunk` for why the answer is computed here rather
    // than re-derived per chunk.
    //
    // Every map here is exactly-one-or-nothing: a key held by more than one
    // existing row yields NO match and is reported in `ambiguousMatchKeys`.
    // That includes refs — duplicate SportLots refs are a known real condition
    // (`indistinguishableSlRefs` in the fetch path), and picking one of two
    // rows claiming the same marketplace card is the silent merge this ticket
    // exists to remove.
    existingIdByBscRef: v.array(
      v.object({ ref: v.string(), id: v.id("cardChecklist") }),
    ),
    existingIdBySlRef: v.array(
      v.object({ ref: v.string(), id: v.id("cardChecklist") }),
    ),
    // Key is `side \0 slotKey \0 cardNumber` — built by `slotNumberMatchKey`,
    // which the action uses on the incoming side too so the two cannot
    // disagree about the shape. Only keys held by EXACTLY ONE existing row
    // appear here; a key two rows share is ambiguous and is reported below
    // instead, never matched.
    existingIdBySlotNumber: v.array(
      v.object({ key: v.string(), id: v.id("cardChecklist") }),
    ),
    // Rows carrying NO ref on either side — custom cards and pre-NEO-137
    // legacy rows. Same exactly-one rule.
    existingIdByNumberNoRef: v.array(
      v.object({ cardNumber: v.string(), id: v.id("cardChecklist") }),
    ),
    // Keys deliberately withheld from the maps above because more than one
    // existing row holds them. Surfaced, never guessed at — the action logs
    // them so an operator can see WHY a card was treated as new.
    ambiguousMatchKeys: v.array(v.string()),
    // The parent row's ATTACHED marketplace sets: marketplace set id → slot
    // key, per side. Tier 2 resolves an incoming card's WIRE `setId` strictly
    // through this map — it never compares a `setId` string against a stored
    // `src` value, because slot keys are short and guessable ("b0") and a
    // marketplace set literally named `b0` must not match anything. An
    // unattached set id yields no slot and therefore no tier-2 match, which is
    // the same "attached slots only, never allocate" rule `resolveCardSlots`
    // enforces at write time.
    slotBySetId: v.array(
      v.object({
        side: v.union(v.literal("bsc"), v.literal("sportlots")),
        setId: v.string(),
        slot: v.string(),
      }),
    ),
  }),
  handler: async (ctx, args): Promise<CommitPrelude> => {
    await requireAdmin(ctx);
    const userId = await getCurrentUserId(ctx);
    if (!userId) throw new Error("Not authenticated");

    // NEO-96: read the sport row ONCE for its SKU code rather than per card.
    // This is the same row addCustomCard reads, which is what finally makes the
    // two creation paths agree on a SKU prefix (they used to emit NB-BA- and
    // NB-BB- for the same set).
    const commitSportRow = await ctx.db.get(args.sportId);
    if (!commitSportRow || commitSportRow.level !== "sport") {
      throw new Error(
        `commitCardChecklist: sportId ${args.sportId} is not a sport-level row`,
      );
    }

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
    // possible. Build name → Id maps so the per-card resolution in the chunks
    // below is O(1) instead of repeated DB lookups.
    const allPlayerNames = new Set<string>();
    const allTeamNames = new Set<string>();
    for (const p of args.playerNames) if (p.trim()) allPlayerNames.add(p.trim());
    for (const t of args.teamNames) if (t.trim()) allTeamNames.add(t.trim());

    // The pre-commit snapshot of this checklist, read ONCE. Three separate
    // things are derived from it (pending* names, preserved custom-card
    // numbers, and the upsert key) — the old single mutation read the table
    // twice for the first and third of those.
    const existingCards = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();

    // Fold in pending* names from custom cards on this variant. Those rows
    // aren't in the fetch preview, so without this pass a reviewed custom-card
    // pending player would never get inserted into the players table.
    for (const r of existingCards) {
      if (!r.isCustom) continue;
      for (const p of r.pendingPlayerNames ?? []) {
        if (p.trim()) allPlayerNames.add(p.trim());
      }
      for (const t of r.pendingTeamNames ?? []) {
        if (t.trim()) allTeamNames.add(t.trim());
      }
    }

    // NEO-92/NEO-212: load this batch's reviewed decisions. Three variants:
    // `create` (insert a row seeded from the cached enrichment), `link` (use
    // an existing row's id), and `skip` — "this is not a person / not a team".
    // A skip creates nothing and links nothing: the card keeps the raw name as
    // free text, exactly as if the name had never been reviewed, and the name
    // is recorded in `entityReviewSkips` below so it never re-enters this
    // set's wizard. Keyed by kind+normalized-name so a player and a team that
    // happen to share a normalized name never collide.
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

    // ── NEO-212: make every skip durable, in THIS transaction ───────────────
    //
    // `entityReviewQueue` rows are per-batch throwaways that the finalize
    // phase deletes, so a skip that lived only there would survive exactly
    // until the next fetch of the set — and the operator would be handed the
    // same "CHECKLIST" header row to rule on again, forever. Recording it in
    // `entityReviewSkips` is what makes the judgement stick;
    // `resolveUnknownsAndStartBatch` reads this table before it enqueues
    // anything.
    //
    // Written HERE, in the prelude mutation, rather than in a later phase or a
    // scheduled follow-up, so it is atomic with the rest of the commit: a
    // commit either lands with its skips recorded or does not land. A skip
    // written outside the transaction could be lost while the cards it applied
    // to were still committed, which is the one failure mode that costs the
    // operator their work.
    //
    // Upsert, not insert: re-committing the same set after skipping the same
    // junk again must leave ONE row (the index key is exactly
    // (selectorOptionId, kind, nameNormalized)), refreshed to the latest
    // decision rather than accumulating a row per commit. `skippedAt` moves
    // forward, and `skippedByUserId` becomes whoever most recently confirmed
    // it — both are audit fields, and "who last stood behind this skip" is the
    // more useful answer than "who first did".
    const skippedPlayerNames: string[] = [];
    const skippedTeamNames: string[] = [];
    for (const row of reviewRows) {
      if (row.decision?.action !== "skip") continue;
      const nameNormalized = norm(row.name);
      const existingSkip = await ctx.db
        .query("entityReviewSkips")
        .withIndex("by_selector_option_and_kind_and_name", (q) =>
          q
            .eq("selectorOptionId", args.selectorOptionId)
            .eq("kind", row.kind)
            .eq("nameNormalized", nameNormalized),
        )
        .first();
      if (existingSkip) {
        await ctx.db.patch(existingSkip._id, {
          skippedAt: Date.now(),
          skippedByUserId: userId,
          // Refreshed alongside the other two audit fields, for the same
          // reason: the row records the CURRENT standing behind the skip, so
          // pointing at the batch that first produced it while naming the
          // operator who most recently reconfirmed it would describe a session
          // that never happened.
          batchId: args.batchId,
        });
      } else {
        await ctx.db.insert("entityReviewSkips", {
          selectorOptionId: args.selectorOptionId,
          kind: row.kind,
          nameNormalized,
          name: row.name,
          skippedAt: Date.now(),
          skippedByUserId: userId,
          // Always defined on this branch in practice — a skip decision only
          // exists on a review row, and review rows are only read when
          // `args.batchId` is set — but typed optional so the field never
          // becomes a reason a commit cannot run.
          batchId: args.batchId,
        });
      }
      // Handed back to the action so the finalize phase can retire the
      // matching `pendingPlayerNames`/`pendingTeamNames` entries on custom
      // cards — see the note there. A skipped name will NEVER resolve, so
      // leaving it pending would re-prompt on every later fetch.
      (row.kind === "player" ? skippedPlayerNames : skippedTeamNames).push(
        row.name,
      );
    }

    // Get-or-create a bare team row by name — used to resolve a newly
    // created player's career-team names (from the wizard's Wikidata
    // preview) to real team ids. Deliberately minimal (no enrichment
    // fields) since these are incidental historical teams, not something
    // the user reviewed directly — same behavior as today's
    // teams.findOrCreateInternal, inlined here since a mutation can't call
    // another mutation via ctx.runMutation.
    //
    // NEO-147: "minimal at insert" is still right, but until now it also
    // meant "never enriched at all". A team the user reviewed goes through
    // processEntityReviewQueue → lookupTeamEnrichment before it is created,
    // so it lands with league/city/colors already on it. A team born HERE
    // skipped that entirely and had no other path to it —
    // processEnrichmentQueue (the queue built for exactly this) had zero
    // callers, so these rows stayed bare forever. Spine labels read
    // teams.colors, so "bare forever" is now user-visible.
    //
    // Collected and returned to the action, which hands them to the finalize
    // phase to enqueue after the writes land, rather than enriching inline:
    // enrichment is a network round-trip per team and this is a mutation.
    // NEO-203: this array carries `enqueueEnrichment`'s creation-only
    // contract, so the early return below is load-bearing — a team that
    // ALREADY EXISTS must leave without being pushed. Enrichment is for rows
    // this commit brought into being; an existing team's data is not re-looked
    // up by any automatic path.
    const enrichmentTeamIds: Array<Id<"teams">> = [];
    const resolveTeamIdByName = async (rawName: string): Promise<Id<"teams">> => {
      const normalized = norm(rawName);
      const existing = await ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", normalized).eq("sportId", args.sportId),
        )
        .first();
      if (existing) return existing._id; // NOT enqueued — see above.
      const id = await ctx.db.insert("teams", {
        name: rawName.trim(),
        nameNormalized: normalized,
        sportId: args.sportId,
        // NEO-156: every team-creation path attaches a league.
        leagueId: await resolveDefaultLeagueId(ctx, args.sportId),
        lastUpdated: Date.now(),
      });
      enrichmentTeamIds.push(id);
      return id;
    };

    const playerIdByName = new Map<string, Id<"players">>();
    // id → canonical stored name, so the chunk phase never has to re-read a
    // player row it did not write.
    const playerNameById = new Map<Id<"players">, string>();
    const createdPlayerIds: Array<Id<"players">> = [];
    for (const name of allPlayerNames) {
      const normalized = norm(name);
      // Compound index returns 0 or 1 row per lookup — independent of how
      // many cross-sport duplicates of this normalized name exist.
      const existing = await ctx.db
        .query("players")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", normalized).eq("sportId", args.sportId),
        )
        .first();
      if (existing) {
        playerIdByName.set(name, existing._id);
        playerNameById.set(existing._id, existing.name);
        continue;
      }
      const decision = reviewByKey.get(`player:${normalized}`)?.decision;
      // Not reviewed (shouldn't happen), or reviewed as "not a person"
      // (NEO-212). Both leave the name out of `playerIdByName`, so the card
      // keeps it as raw text and links to nothing — a skip is deliberately
      // indistinguishable, at the card, from a name that was never resolved.
      // The skip's durability comes from `entityReviewSkips` above, not from
      // anything written here.
      if (!decision || decision.action === "skip") continue;
      if (decision.action === "link") {
        if (decision.linkedPlayerId) {
          playerIdByName.set(name, decision.linkedPlayerId);
          // The LINKED row's own spelling is what the old write loop's
          // `db.get(...).name` produced, so read it here (once) rather than
          // assuming the reviewed name matches it.
          if (!playerNameById.has(decision.linkedPlayerId)) {
            const linked = await ctx.db.get(decision.linkedPlayerId);
            if (linked) playerNameById.set(decision.linkedPlayerId, linked.name);
          }
        }
        continue;
      }
      // decision.action === "create" — seed directly from the wizard's own
      // Wikidata preview lookup (already fetched during review); no more
      // post-commit processEnrichmentQueue scheduling needed for this row.
      const enrichment = reviewByKey.get(`player:${normalized}`)?.enrichment;
      // Merge the wizard's Wikidata preview career-teams with any the admin
      // added by hand in the review wizard (decision.manualCareerTeams). Both
      // are {name, fromYear, toYear?} — resolve every name to a real team id
      // via get-or-create, then key by `(teamId, fromYear)`.
      //
      // ── NEO-212: the key is the STINT, not the team ────────────────────────
      //
      // This used to be a `Map<teamId, years>`, which quietly destroyed the
      // most interesting thing in a career: a player traded away and later
      // re-signed by the same franchise has two P54 statements for that team,
      // and the second one overwrote the first. What survived was one entry
      // spanning whichever stint happened to come last — a timeline that was
      // not merely incomplete but wrong about the years it did show.
      //
      // With `(teamId, fromYear)` the two behaviours the merge needs fall out
      // of one rule:
      //   - a manual entry with the SAME (teamId, fromYear) as a Wikidata
      //     entry REPLACES it. That is the admin explicitly correcting the
      //     years on a stint Wikidata also knows about ("2011–2018 should read
      //     2011–2019"), so the manual `toYear` must win rather than be
      //     silently discarded.
      //   - a manual entry with a DIFFERENT fromYear APPENDS. That is the
      //     admin adding a stint Wikidata missed entirely, at a team it does
      //     know — the returning-player case, which the old key could not
      //     express at all.
      // Wikidata entries go in first, manual entries `.set()` over colliding
      // keys, and the final array is ordered by `sortTeamYears` rather than by
      // insertion, so the stored timeline is chronological regardless of which
      // source contributed which stint.
      const manualCareerTeams =
        decision.action === "create" ? (decision.manualCareerTeams ?? []) : [];
      // NEO-212: career teams the operator UNCHECKED in the wizard. Filtered
      // BEFORE resolveTeamIdByName runs, and that ordering is the whole point:
      // resolving a name is get-or-CREATE, so merely asking for the id of an
      // excluded team would mint the very `teams` row the operator just
      // rejected — a row nothing then points at, and which the next lookup of
      // that name would silently adopt. Matched on the normalized name for the
      // same reason every other name comparison here is: the exclusion list is
      // built from UI labels and must not be defeated by punctuation.
      const excludedCareerTeamNames = new Set(
        (decision.action === "create"
          ? (decision.excludedCareerTeamNames ?? [])
          : []
        ).map(norm),
      );
      const teamYearByKey = new Map<
        string,
        { teamId: Id<"teams">; fromYear: number; toYear?: number }
      >();
      for (const ct of enrichment?.careerTeams ?? []) {
        if (excludedCareerTeamNames.has(norm(ct.name))) continue;
        const teamId = await resolveTeamIdByName(ct.name);
        teamYearByKey.set(`${teamId}|${ct.fromYear}`, {
          teamId,
          fromYear: ct.fromYear,
          toYear: ct.toYear,
        });
      }
      for (const ct of manualCareerTeams) {
        const teamId = await resolveTeamIdByName(ct.name);
        teamYearByKey.set(`${teamId}|${ct.fromYear}`, {
          teamId,
          fromYear: ct.fromYear,
          toYear: ct.toYear,
        });
      }
      const teamYears: Array<{ teamId: Id<"teams">; fromYear: number; toYear?: number }> =
        sortTeamYears(Array.from(teamYearByKey.values()));
      const id = await ctx.db.insert("players", {
        name: name.trim(),
        nameNormalized: normalized,
        sportId: args.sportId,
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
      playerNameById.set(id, name.trim());
      createdPlayerIds.push(id);
    }

    const teamIdByName = new Map<string, Id<"teams">>();
    const teamNameById = new Map<Id<"teams">, string>();
    const createdTeamIds: Array<Id<"teams">> = [];
    for (const name of allTeamNames) {
      const normalized = norm(name);
      const existing = await ctx.db
        .query("teams")
        .withIndex("by_name_normalized_and_sport_id", (q) =>
          q.eq("nameNormalized", normalized).eq("sportId", args.sportId),
        )
        .first();
      if (existing) {
        teamIdByName.set(name, existing._id);
        teamNameById.set(existing._id, existing.name);
        continue;
      }
      const decision = reviewByKey.get(`team:${normalized}`)?.decision;
      // Same as the player loop above — unreviewed or NEO-212 "not a team".
      // The card keeps the raw name, nothing is created or linked.
      if (!decision || decision.action === "skip") continue;
      if (decision.action === "link") {
        if (decision.linkedTeamId) {
          teamIdByName.set(name, decision.linkedTeamId);
          // The LINKED row's own spelling, not the reviewed name — same
          // reasoning as `playerNameById` above, and read at most once.
          if (!teamNameById.has(decision.linkedTeamId)) {
            const linked = await ctx.db.get(decision.linkedTeamId);
            if (linked) teamNameById.set(decision.linkedTeamId, linked.name);
          }
        }
        continue;
      }
      const enrichment = reviewByKey.get(`team:${normalized}`)?.enrichment;
      // NEO-156: the wizard's enrichment carries a league NAME. Resolve it to
      // a real row rather than storing the string, so two spellings of one
      // league cannot become two leagues. Falls back to the sport's default
      // when enrichment found none, so this path attaches a league either way.
      const leagueId = enrichment?.league
        ? await findOrCreateLeague(ctx, {
            name: enrichment.league,
            sportId: args.sportId,
          })
        : await resolveDefaultLeagueId(ctx, args.sportId);
      const id = await ctx.db.insert("teams", {
        name: name.trim(),
        nameNormalized: normalized,
        sportId: args.sportId,
        lastUpdated: Date.now(),
        ...(leagueId ? { leagueId } : {}),
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
      teamNameById.set(id, name.trim());
      createdTeamIds.push(id);
    }

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

    // Still need the nearest setName ancestor id (unrelated to features — used
    // only for the totalCardCount/lastSyncedAt patch in the finalize phase).
    let setNameAncestorId: Id<"selectorOptions"> | undefined =
      leafNode?.level === "setName" ? leafNode._id : undefined;
    if (!setNameAncestorId) {
      let cursorId: Id<"selectorOptions"> | undefined = leafNode?.parentId;
      while (cursorId && !setNameAncestorId) {
        const node: Doc<"selectorOptions"> | null = await ctx.db.get(cursorId);
        if (!node) break;
        if (node.level === "setName") setNameAncestorId = node._id;
        cursorId = node.parentId;
      }
    }
    // Fetched once for the whole batch (not per-card) — used only for
    // listing-title/description generation on newly-inserted rows.
    const setNameValue = setNameAncestorId
      ? (await ctx.db.get(setNameAncestorId))?.value
      : undefined;

    // ── NEO-203: the match maps ─────────────────────────────────────────────
    //
    // Built by `buildMatchMaps`, which is SHARED with the read-only review
    // query `diffChecklistAgainstExisting` — see the note there for why the
    // rule cannot be allowed to live in two places. The maps are derived
    // entirely from the `existingCards` snapshot read above plus the leaf
    // node, so this phase does no extra database work for them.
    //
    // The `withheld` half is deliberately dropped here: it is raw, untruncated
    // marketplace text, and this value crosses a function boundary into the
    // action. The commit path only needs the bounded `ambiguousMatchKeys` for
    // its log line; the review query, which computes in one process, keeps it.
    const { maps: matchMaps } = buildMatchMaps(existingCards, leafNode);

    return {
      userId,
      sportSkuCode: commitSportRow.sportConfig?.skuCode,
      sportValue: commitSportRow.value ?? "",
      playerIdByName: Array.from(playerIdByName, ([name, id]) => ({ name, id })),
      teamIdByName: Array.from(teamIdByName, ([name, id]) => ({ name, id })),
      playerNameById: Array.from(playerNameById, ([id, name]) => ({ id, name })),
      teamNameById: Array.from(teamNameById, ([id, name]) => ({ id, name })),
      createdPlayerIds,
      createdTeamIds,
      enrichmentTeamIds,
      reviewRowIds: reviewRows.map((r) => r._id),
      skippedPlayerNames,
      skippedTeamNames,
      inheritedFeatures: inheritedFeaturesOrUndefined,
      setNameAncestorId,
      setNameValue,
      existingCustomCardNumbers: existingCards
        .filter((c) => c.isCustom)
        .map((c) => c.cardNumber),
      ...matchMaps,
    };
  },
});

type CommitPrelude = {
  userId: string;
  sportSkuCode?: string;
  sportValue: string;
  playerIdByName: Array<{ name: string; id: Id<"players"> }>;
  teamIdByName: Array<{ name: string; id: Id<"teams"> }>;
  playerNameById: Array<{ id: Id<"players">; name: string }>;
  teamNameById: Array<{ id: Id<"teams">; name: string }>;
  createdPlayerIds: Array<Id<"players">>;
  createdTeamIds: Array<Id<"teams">>;
  enrichmentTeamIds: Array<Id<"teams">>;
  reviewRowIds: Array<Id<"entityReviewQueue">>;
  skippedPlayerNames: string[];
  skippedTeamNames: string[];
  inheritedFeatures?: Record<string, string>;
  setNameAncestorId?: Id<"selectorOptions">;
  setNameValue?: string;
  existingCustomCardNumbers: string[];
  existingIdByBscRef: Array<{ ref: string; id: Id<"cardChecklist"> }>;
  existingIdBySlRef: Array<{ ref: string; id: Id<"cardChecklist"> }>;
  existingIdBySlotNumber: Array<{ key: string; id: Id<"cardChecklist"> }>;
  existingIdByNumberNoRef: Array<{
    cardNumber: string;
    id: Id<"cardChecklist">;
  }>;
  ambiguousMatchKeys: string[];
  slotBySetId: Array<{ side: MatchSide; setId: string; slot: string }>;
};

/**
 * One card as the chunk phase sees it: names already resolved to ids by the
 * action, sortOrder already computed across the WHOLE commit, and the row this
 * card upserts into already decided against the pre-commit snapshot.
 *
 * Nothing here is re-derived per chunk, which is the point: a chunk is a dumb
 * writer, so two chunks of the same commit cannot disagree about anything.
 */
const commitChunkCardValidator = v.object({
  cardNumber: v.string(),
  cardName: v.string(),
  playerIds: v.optional(v.array(v.id("players"))),
  teamOnCardIds: v.optional(v.array(v.id("teams"))),
  attributes: v.optional(v.array(v.string())),
  isRookie: v.optional(v.boolean()),
  isRelic: v.optional(v.boolean()),
  printRun: v.optional(v.number()),
  autographType: v.optional(v.string()),
  cardVariation: v.optional(v.string()),
  // NEO-137: still the WIRE shape (marketplace set ids); the chunk resolves it
  // to slots on the parent row, which is a per-chunk read of a single doc.
  platformData: cardPlatformWireDataValidator,
  sortOrder: v.number(),
  // Canonical names of `playerIds`, resolved once in the prelude.
  playerNames: v.array(v.string()),
  // NEO-101: canonical names of `teamOnCardIds`, likewise resolved once in the
  // prelude. Consumed by listing-title generation in the insert branch.
  teamNames: v.array(v.string()),
  // The pre-commit row this card upserts into, or absent to insert a new row.
  existingId: v.optional(v.id("cardChecklist")),
  // NEO-203 — which NB-owned content fields the operator accepted for THIS
  // card. Absent or empty means linkage-only: the row's `platformData` is
  // refreshed and nothing it says about the card is touched.
  //
  // Names are validated against `NB_CONTENT_FIELDS` in the handler and
  // anything unrecognised is dropped, so a stale or hostile client can only
  // ever narrow what is written, never widen it.
  applyFields: v.optional(v.array(v.string())),
  // NEO-203 — the matched row's `lastUpdated` as it stood when the operator
  // was shown the diff. If the stored row has moved since, the decision was
  // made against content that no longer exists, so NO content is applied and
  // the card is reported. Required whenever `applyFields` is non-empty: an
  // unverifiable decision is treated the same as no decision.
  baseVersion: v.optional(v.number()),
});

/**
 * NEO-189 — upsert one slice of the checklist. Called once per
 * CARDS_PER_COMMIT_CHUNK cards by the `commitCardChecklist` action.
 *
 * ## Why the upsert key is passed in rather than recomputed
 *
 * The old single mutation snapshotted `cardChecklist` before its write loop and
 * keyed the upsert on `existingByNumber` built from that snapshot — so rows the
 * loop itself inserted were never candidates, and a checklist carrying the same
 * card number twice (BSC splits 1996 Score Dugout Collection Artist's Proofs
 * into Series 1 and Series 2, both numbered #1-110) inserted two rows. See
 * convex/commitCardChecklist.duplicateNumbers.test.ts.
 *
 * A chunk re-reading the table would see the PREVIOUS chunk's inserts and
 * collapse those duplicates into one patched row — a silent data loss that
 * chunking would have introduced on its own. So the action resolves each card's
 * target row once, from the prelude's pre-commit snapshot, and hands it down.
 *
 * NEO-203 replaced that key. It is no longer cardNumber-with-last-row-wins but
 * a ref-first cascade resolved in the action (`resolveExistingIds`), and two
 * incoming cards can no longer resolve to the same stored row at all — the
 * second one loses the collision and becomes an insert, marked and logged. So
 * the cross-chunk read-your-own-write caveat this note used to carry is gone.
 *
 * ## What a MATCHED row may have written to it (NEO-203)
 *
 * NeonBinder owns its card data; a marketplace exists only to link an NB card
 * back to a marketplace for listing. A matched row therefore always gets its
 * `platformData` linkage refreshed — that is the entire point of the sync —
 * and gets a content field written only when ALL of the following hold:
 *
 *   1. the operator named that field in `applyFields`;
 *   2. `NB_CONTENT_FIELDS` recognises the name;
 *   3. the card's `baseVersion` still matches the stored row's `lastUpdated`,
 *      so the decision was made against the content actually on the row;
 *   4. the incoming value actually DIFFERS from the stored one.
 *
 * Every one of those can only ever narrow the patch. Absent `applyFields` (an
 * older SPA talking to this backend mid-deploy, or any caller that predates
 * the review UI) writes no content at all — this fails closed, never "patch
 * unless told not to".
 *
 * ## Why the commit still takes wire cards rather than re-reading candidates
 *
 * The values written here arrive from the client rather than being re-read
 * server-side from `checklistCandidates`. That is deliberate and was accepted
 * with three compensating controls, all in this handler: the fail-closed
 * `applyFields` gate, the `baseVersion` re-check against the row as it stands
 * INSIDE this transaction (the model is `cardChecklist.applyBscTeamResolution`),
 * and the server-side re-diff that drops fields whose value did not change.
 * The patch is a literal field-by-field enumeration and the incoming card is
 * never spread, so `selectorOptionId`, `sku`, `isCustom`, `features`,
 * `variationOfCardId` and `variationParentManual` cannot be reached from this
 * path whatever `applyFields` says.
 */
export const commitCardChecklistChunk = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    cards: v.array(commitChunkCardValidator),
    sportSkuCode: v.optional(v.string()),
    sportValue: v.string(),
    setNameValue: v.optional(v.string()),
    inheritedFeatures: v.optional(v.record(v.string(), v.string())),
  },
  returns: v.object({
    storedIds: v.array(v.id("cardChecklist")),
    bscTeamEnrichmentIds: v.array(v.id("cardChecklist")),
    // NEO-203 — rows whose accepted content was NOT applied because the row
    // moved between the operator seeing the diff and this transaction running
    // (or because the decision arrived unverifiable, with no `baseVersion`).
    // Linkage was still refreshed for them; only content was withheld.
    staleDecisionIds: v.array(v.id("cardChecklist")),
    // How many matched rows actually had a content field written, for the
    // action's commit log. A count, never the values.
    contentAppliedCount: v.number(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    storedIds: Array<Id<"cardChecklist">>;
    bscTeamEnrichmentIds: Array<Id<"cardChecklist">>;
    staleDecisionIds: Array<Id<"cardChecklist">>;
    contentAppliedCount: number;
  }> => {
    const toStoredPlatformData = await resolveCardSlots(
      ctx,
      args.selectorOptionId,
    );

    // One indexed read for the whole chunk instead of a `db.get` per card:
    // the rows this chunk patches are looked up by id in this map. Skipped
    // entirely when every card in the chunk is an insert (the first sync of a
    // set), which is the common case.
    const rowsById = new Map<string, Doc<"cardChecklist">>();
    if (args.cards.some((c) => c.existingId)) {
      const rows = await ctx.db
        .query("cardChecklist")
        .withIndex("by_selector_option", (q) =>
          q.eq("selectorOptionId", args.selectorOptionId),
        )
        .collect();
      for (const row of rows) rowsById.set(row._id, row);
    }

    const storedIds: Array<Id<"cardChecklist">> = [];
    // NEO-90: cards touched by this chunk that have a BSC platform ref but no
    // team resolved yet. Returned to the action, which unions every chunk's
    // list and hands it to the finalize phase to schedule.
    const bscTeamEnrichmentIds: Array<Id<"cardChecklist">> = [];
    const staleDecisionIds: Array<Id<"cardChecklist">> = [];
    let contentAppliedCount = 0;

    for (const card of args.cards) {
      // Deliberately `rowsById.get`, not `ctx.db.get`: the map is this
      // selectorOption's own snapshot, so an id that is foreign to this
      // checklist (or that another writer deleted since the prelude read)
      // simply misses and the card falls through to the insert branch.
      const existing = card.existingId ? rowsById.get(card.existingId) : undefined;
      if (existing) {
        storedIds.push(existing._id);
        // Merge per side so a sync that resolves only one marketplace does not
        // wipe the other side's confirmed ref.
        const mergedPlatformData = {
          ...existing.platformData,
          ...toStoredPlatformData(card.platformData, existing.platformData),
        };

        // ── NEO-203: what, if anything, of the incoming CONTENT applies ─────
        //
        // Fail closed at every step. `applyFields` absent or empty is the
        // default and means linkage-only.
        const requested = card.applyFields ?? [];
        // The decision has to have been made against the row as it stands.
        // Re-checked HERE, inside the transaction that writes, exactly as
        // `cardChecklist.applyBscTeamResolution` re-reads before applying a
        // background team result.
        const versionOk =
          card.baseVersion !== undefined &&
          card.baseVersion === existing.lastUpdated;
        if (requested.length > 0 && !versionOk) {
          staleDecisionIds.push(existing._id);
        }
        const accepted: Set<string> =
          requested.length > 0 && versionOk
            ? new Set(requested.filter((f) => NB_CONTENT_FIELD_SET.has(f)))
            : new Set();

        // The incoming value of each NB-owned field, enumerated literally.
        // Never a spread of `card` — this list is the complete set of things
        // a marketplace re-sync is allowed to say about an existing NB card.
        const incoming: Record<NbContentField, unknown> = {
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
        };
        // Re-diff server-side: an accepted field whose value did not actually
        // change is not written. Only ever fewer fields than asked for.
        const contentPatch: Record<string, unknown> = {};
        for (const field of NB_CONTENT_FIELDS) {
          if (!accepted.has(field)) continue;
          if (sameContentValue(existing[field], incoming[field])) continue;
          contentPatch[field] = incoming[field];
        }
        if (Object.keys(contentPatch).length > 0) contentAppliedCount++;

        // ── NEO-102: the operator's "no team" confirmation ─────────────────
        //
        // Retired only when a NON-EMPTY `teamOnCardIds` is ACTUALLY written in
        // this transaction — i.e. when it came through the `applyFields` +
        // `baseVersion` gate above and survived the server-side re-diff. That
        // is the same one gate, not a second one: no `applyFields` entry, a
        // stale `baseVersion`, or a value that re-diffed as unchanged all mean
        // nothing was written and the flag is left exactly as it stands.
        //
        // Which also settles the two cases that would otherwise be wrong:
        // a LINKAGE-ONLY refresh (the common re-sync, and the whole reason
        // this phase runs) never touches the flag, and a sync whose card
        // carries no teams never touches it either — an empty upstream answer
        // is not evidence against a human's answer, it is what produced the
        // question. Nothing in the commit path ever SETS the flag; that is
        // `cardChecklist.confirmCardNoTeam`'s job alone.
        const teamIdsWritten = Array.isArray(contentPatch.teamOnCardIds)
          ? (contentPatch.teamOnCardIds as Array<Id<"teams">>)
          : undefined;
        const retireNoneConfirmed =
          existing.teamNoneConfirmedAt !== undefined &&
          teamIdsWritten !== undefined &&
          teamIdsWritten.length > 0;

        await ctx.db.patch(existing._id, {
          ...contentPatch,
          // Patching `undefined` is how Convex deletes a field. Spread only
          // when it applies, so an untouched row's patch is byte-identical to
          // what it was before this feature existed.
          ...(retireNoneConfirmed
            ? {
                teamNoneConfirmedAt: undefined,
                teamNoneConfirmedByUserId: undefined,
              }
            : {}),
          // Linkage is ALWAYS refreshed — routing a marketplace's update to
          // the row linked to it is the whole reason this sync exists, and it
          // is not content NeonBinder owns.
          platformData: mergedPlatformData,
          // NEO-203: sortOrder stays unconditional. It is NB-owned ordering
          // bookkeeping derived from card numbers across the whole commit, not
          // anything the marketplace said about this card, so leaving it
          // un-restamped on an unreviewed re-sync would desynchronise the
          // checklist's display order from its own contents.
          sortOrder: card.sortOrder,
          lastUpdated: Date.now(),
        });
        // Enrichment keys off what the row will actually HAVE after this
        // patch, not off what the marketplace sent: when content was not
        // applied, the stored teams are still the row's answer.
        const effectiveTeamIds =
          contentPatch.teamOnCardIds !== undefined
            ? card.teamOnCardIds
            : existing.teamOnCardIds;
        // NEO-102: and never re-derive a team for a card an operator settled
        // as teamless. Read off what the row will HAVE after this patch, like
        // `effectiveTeamIds` above — a commit that just retired the flag
        // (because it wrote real teams) is not suppressed by it, and one that
        // left it standing is.
        const noneConfirmedAfter = retireNoneConfirmed
          ? undefined
          : existing.teamNoneConfirmedAt;
        if (
          mergedPlatformData.bsc &&
          (!effectiveTeamIds || effectiveTeamIds.length === 0) &&
          !existing.teamCheckDoneAt &&
          !noneConfirmedAfter
        ) {
          bscTeamEnrichmentIds.push(existing._id);
        }
      } else {
        // NEO-71-74: precedence = the leaf node's complete features snapshot
        // (already resolved at that node's own creation time) < card-observed
        // facts. A fact seen on THIS card (e.g. it's a rookie) beats the
        // inherited values.
        const mergedFeatures: Record<string, string> = {
          ...(args.inheritedFeatures ?? {}),
          ...deriveCardObservedFeatures(card),
        };
        // A card arriving already-autographed (marketplace data carried an
        // autographType) gets the same "just became non-None -> default
        // Signed By from the roster" treatment `setCardFeature` applies for
        // a manual operator edit — the roster is already resolved as real
        // IDs at this point (see the player/team findOrCreate pass in the
        // prelude).
        const wasBlank = (args.inheritedFeatures?.autographed ?? "None") === "None";
        const isNowSet =
          !!mergedFeatures.autographed && mergedFeatures.autographed !== "None";

        // Resolved in the prelude, once per player rather than once per card:
        // used for the signedBy default below (only when autographed just
        // turned on) AND unconditionally for listing generation further down.
        const playerNames = card.playerNames;
        if (wasBlank && isNowSet && !mergedFeatures.signedBy && playerNames.length > 0) {
          mergedFeatures.signedBy = playerNames.join(", ");
        }
        const featuresOrUndefined =
          Object.keys(mergedFeatures).length > 0 ? mergedFeatures : undefined;

        // NEO-24/71-74: write-once listing title/description, generated
        // once here at creation time, then freely editable afterward (same
        // model as every other default this session).
        const listingInputs: ListingCardInputs = {
          cardNumber: card.cardNumber,
          playerNames,
          year: mergedFeatures.season,
          manufacturer: mergedFeatures.manufacturer,
          setName: args.setNameValue,
          parallelName: mergedFeatures.parallelName,
          isRookie: card.isRookie,
          isRelic: card.isRelic,
          autographed: mergedFeatures.autographed,
          // NEO-101: `printRun` was in the generator's token list from the
          // start but was never actually passed from here, so no synced card
          // has ever had `/99` in its title while `previewListingTitle`'s
          // Regenerate would put one there. Passed now, so creation and
          // regeneration agree.
          printRun: card.printRun,
          shortPrint: mergedFeatures.shortPrint,
          // NEO-101/189: NB's own per-card variation name, used verbatim in
          // both the title (as an optional token) and the description. Same
          // value written to the row's `cardVariation` column below.
          cardVariation: card.cardVariation,
          // NEO-101: resolved once per commit in the prelude, not per card —
          // roughly half of sold listings name the team, so this is a real
          // search term rather than filler.
          teamNames: card.teamNames,
          // NEO-101: the sport ancestor's value, already resolved by the
          // prelude for the SKU prefix. The weakest token in the title and the
          // last one tried; frequently de-duplicated away by a team name that
          // already contains the word.
          sport: args.sportValue,
        };
        const listingTitle = assessListingTitle(listingInputs);

        const newCardId: Id<"cardChecklist"> = await ctx.db.insert("cardChecklist", {
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
          platformData: toStoredPlatformData(card.platformData),
          // NEO-24: inherit ancestor + derive per-card on insert. Existing
          // rows are owned by the propagation engine; never clobbered here.
          ...(featuresOrUndefined ? { features: featuresOrUndefined } : {}),
          listingTitle: listingTitle.title,
          listingDescription: generateListingDescription(listingInputs),
          // NEO-101: only when the core was actually cut (see schema.ts).
          ...(listingTitle.coreFits ? {} : { listingTitleTruncated: true }),
          sortOrder: card.sortOrder,
          lastUpdated: Date.now(),
        });
        // NEO-91: SKU can only be generated once the row exists (the random
        // suffix — not the id — is what guarantees uniqueness, but the id
        // has to exist before we can patch it in). Cheap, well-precedented
        // insert-then-patch pattern already used elsewhere in this file.
        storedIds.push(newCardId);
        await ctx.db.patch(newCardId, {
          sku: generateSku({
            skuCode: args.sportSkuCode,
            sportFallbackLabel: args.sportValue,
            year: mergedFeatures.season ?? "",
            setName: args.setNameValue ?? "",
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

    return {
      storedIds,
      bscTeamEnrichmentIds,
      staleDecisionIds,
      contentAppliedCount,
    };
  },
});

/**
 * NEO-189 — the once-per-commit tail of `commitCardChecklist`, run after every
 * chunk has written.
 *
 * Everything here needs the WHOLE commit in view, which is exactly why it
 * cannot live in a chunk:
 *
 *  - variation links, whose parent may have been written by a different chunk;
 *  - the stale-card sweep, which must be told the union of every chunk's
 *    committed ids/numbers or it would delete the other chunks' cards;
 *  - the preserved-custom-card sortOrder pass, computed across all cards;
 *  - review-row cleanup, the enrichment schedules, and the setName ancestor's
 *    totalCardCount.
 *
 * Reads the checklist ONCE and works from that map. The old single mutation did
 * a `db.get` per stored id here — twice — which was a large share of the
 * per-commit system-operation budget it eventually blew.
 */
export const commitCardChecklistFinalize = internalMutation({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    // Union of every chunk's stored ids, and every committed card number.
    // Nothing is deleted on the strength of these anymore (see
    // `operatorDeleteIds`) — they identify the rows this commit touched, which
    // is what the unmatched-existing report is computed against and what the
    // custom-card sortOrder pass keys on.
    committedIds: v.array(v.id("cardChecklist")),
    committedNumbers: v.array(v.string()),
    // ── NEO-203: deletion is an OPERATOR ACTION, not a sync side effect ─────
    //
    // This phase used to delete every non-custom row the incoming payload did
    // not account for. That made a marketplace the authority on whether a
    // NeonBinder card exists: BSC dropping a listing, or a fetch returning a
    // short checklist, silently destroyed NB rows and their cross-listings.
    // NeonBinder owns its sets — a marketplace could be dropped entirely
    // tomorrow and every NB set must stand untouched.
    //
    // So the sweep now REPORTS (`unmatchedExistingIds`) and deletes only what
    // an operator explicitly named. Deletion stays in this phase, and not in a
    // chunk, for the reason the atomicity note on the action gives: finalize
    // is a single transaction, so a partial delete is not a reachable state.
    operatorDeleteIds: v.array(v.id("cardChecklist")),
    variationLinks: v.array(
      v.object({
        childId: v.id("cardChecklist"),
        parentId: v.id("cardChecklist"),
      }),
    ),
    variationClearIds: v.array(v.id("cardChecklist")),
    customSortOrders: v.array(
      v.object({ cardNumber: v.string(), sortOrder: v.number() }),
    ),
    resolvedPlayerNames: v.array(v.string()),
    resolvedTeamNames: v.array(v.string()),
    // NEO-212: names the operator ruled "not a person / not a team" this
    // commit (recorded in `entityReviewSkips` by the prelude). Treated exactly
    // like a resolved name for the purpose of clearing custom cards' pending*
    // entries below — see the note there.
    skippedPlayerNames: v.array(v.string()),
    skippedTeamNames: v.array(v.string()),
    reviewRowIds: v.array(v.id("entityReviewQueue")),
    enrichmentTeamIds: v.array(v.id("teams")),
    bscTeamEnrichmentIds: v.array(v.id("cardChecklist")),
    setNameAncestorId: v.optional(v.id("selectorOptions")),
    cardCount: v.number(),
  },
  returns: v.object({
    variationsLinked: v.number(),
    // How many of `operatorDeleteIds` were actually deleted. The rest were
    // refused by one of the guards below and are counted separately.
    operatorDeleted: v.number(),
    deleteSkipped: v.number(),
    // Non-custom rows in this checklist that no incoming card matched — the
    // ones that vanished upstream. Reported, never acted on.
    unmatchedExistingIds: v.array(v.id("cardChecklist")),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    variationsLinked: number;
    operatorDeleted: number;
    deleteSkipped: number;
    unmatchedExistingIds: Array<Id<"cardChecklist">>;
  }> => {
    const rows = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();
    const rowsById = new Map<string, Doc<"cardChecklist">>();
    for (const row of rows) rowsById.set(row._id, row);

    // ── NEO-189: link each variation to the card it varies ──────────────────
    //
    // The pairs were resolved by the action, which is the only place that can
    // see both a child in chunk 3 and its parent in chunk 1. The grouping rule
    // itself lives in lib/cards/variations.ts and is deliberately not "a
    // suffixed number belongs to the bare one" — 2021 Topps has no card #1 at
    // all, only 1a/1b/1c, and SportLots gives every variation of #13 the number
    // 13. What holds is: group by card-number stem, and the single row in the
    // group that is NOT a variation is the parent.
    //
    // NEO-189: a hand-set parent is the operator's answer and outranks the
    // derivation, exactly as a confirmed card pairing does (NEO-137). Without
    // the `variationParentManual` check the pass below would re-derive the link
    // from the stem and clear anything it did not derive, so a correction would
    // survive only until the next fetch.
    let variationsLinked = 0;
    for (const { childId, parentId } of args.variationLinks) {
      const child = rowsById.get(childId);
      if (!child || child.variationParentManual) continue;
      await ctx.db.patch(childId, {
        variationOfCardId: parentId,
        lastUpdated: Date.now(),
      });
      variationsLinked++;
    }
    // A row that USED to be a variation and no longer is must lose its pointer,
    // or a re-sync after an upstream correction leaves it parented to the wrong
    // card forever.
    for (const id of args.variationClearIds) {
      const row = rowsById.get(id);
      if (!row || row.variationParentManual) continue;
      if (row.variationOfCardId) {
        await ctx.db.patch(id, {
          variationOfCardId: undefined,
          lastUpdated: Date.now(),
        });
      }
    }

    const committedIds = new Set<string>(args.committedIds);
    const committedNumbers = new Set(args.committedNumbers);

    // ── NEO-203: explicit deletes, then the report ──────────────────────────
    //
    // Five guards, in order, and every refusal is counted rather than thrown:
    // a bad id in this list must not lose the operator the rest of a commit
    // that has already written every chunk.
    if (args.operatorDeleteIds.length > MAX_OPERATOR_DELETE_IDS) {
      throw new Error(
        `commitCardChecklistFinalize: ${args.operatorDeleteIds.length} operatorDeleteIds exceeds the ${MAX_OPERATOR_DELETE_IDS} limit for a single commit`,
      );
    }
    const requestedDeletes = new Set<string>(args.operatorDeleteIds);
    const deletedIds: Array<Id<"cardChecklist">> = [];
    let deleteSkipped = 0;
    for (const id of requestedDeletes) {
      // 1. It must be a row of THIS checklist. `rowsById` is the
      //    `by_selector_option` snapshot, so an id belonging to another set —
      //    or one already gone — simply is not here. Skipped, never deleted,
      //    never thrown.
      const row = rowsById.get(id);
      if (!row) {
        deleteSkipped++;
        continue;
      }
      // 2. Custom cards are NeonBinder's own, never marketplace-derived, and
      //    have no upstream that could have dropped them.
      if (row.isCustom) {
        deleteSkipped++;
        continue;
      }
      // 3. The row came back in THIS sync. Whatever the operator decided when
      //    they were shown the previous state, upstream still lists this card,
      //    so deleting it now would discard a row the same commit just wrote.
      if (committedIds.has(row._id) || committedNumbers.has(row.cardNumber)) {
        deleteSkipped++;
        continue;
      }
      // NEO-21: drop this card's cross-listing rows before the card itself.
      await deleteCardCrossListingsFor(ctx, row._id);
      // NEO-189: and re-parent anything that varies it. The old inference
      // sweep deleted rows without this, which left variations pointing at a
      // row that no longer existed — `deleteCard` has always done both.
      await orphanVariationsOf(ctx, row._id);
      await ctx.db.delete(row._id);
      deletedIds.push(row._id);
    }

    // What upstream no longer lists. NOT deleted — surfaced, so the operator
    // can decide, which is what `operatorDeleteIds` above carries back on a
    // later commit.
    const unmatchedExistingIds: Array<Id<"cardChecklist">> = [];
    for (const existing of rows) {
      if (existing.isCustom) continue;
      if (committedIds.has(existing._id)) continue;
      if (requestedDeletes.has(existing._id)) continue;
      unmatchedExistingIds.push(existing._id);
    }

    // One audit line per commit that touched deletions. Ids and counts only.
    if (args.operatorDeleteIds.length > 0) {
      console.log(
        JSON.stringify({
          msg: "commit_card_operator_deletes",
          selectorOptionId: args.selectorOptionId,
          userId: await getCurrentUserId(ctx),
          requested: args.operatorDeleteIds.length,
          deleted: deletedIds.length,
          skipped: deleteSkipped,
          deletedIds,
        }),
      );
    }

    // Patch preserved custom cards whose sortOrder shifted because of the
    // marketplace upsert. The targets were computed by the action across the
    // whole commit; no reads here beyond the single collect above.
    const customSortOrder = new Map<string, number>();
    for (const { cardNumber, sortOrder } of args.customSortOrders) {
      customSortOrder.set(cardNumber, sortOrder);
    }
    for (const existing of rows) {
      if (!existing.isCustom) continue;
      if (committedNumbers.has(existing.cardNumber)) continue; // not preserved; replaced
      const target = customSortOrder.get(existing.cardNumber);
      if (target !== undefined && existing.sortOrder !== target) {
        await ctx.db.patch(existing._id, { sortOrder: target });
      }
    }

    // Clear pendingPlayerNames / pendingTeamNames entries on custom cards
    // for names that are now resolved (either pre-existing in players/teams
    // or just created via the confirmed-new lists). Without this, every
    // subsequent fetchCardChecklist would keep re-prompting for the same
    // custom-card player names because they'd stay in pending* forever.
    //
    // NEO-212: a SKIPPED name is cleared by the same pass, on the same
    // reasoning taken one step further. "Pending" means "waiting to become a
    // players/teams row"; the operator has just ruled that this name never
    // will be one, so it is not waiting for anything — it is settled, and the
    // card keeps it as the free text it always was. Left pending it would be
    // re-offered on every later fetch, which is exactly the loop
    // `entityReviewSkips` exists to break, and the skip would only half-work:
    // suppressed for marketplace names, still nagging for custom-card ones.
    const resolvedPlayerNames = new Set([
      ...args.resolvedPlayerNames,
      ...args.skippedPlayerNames,
    ]);
    const resolvedTeamNames = new Set([
      ...args.resolvedTeamNames,
      ...args.skippedTeamNames,
    ]);
    for (const existing of rows) {
      if (!existing.isCustom) continue;
      const patch: {
        pendingPlayerNames?: string[];
        pendingTeamNames?: string[];
      } = {};
      if (existing.pendingPlayerNames && existing.pendingPlayerNames.length > 0) {
        const stillPending = existing.pendingPlayerNames.filter(
          (n) => !resolvedPlayerNames.has(n.trim()),
        );
        if (stillPending.length !== existing.pendingPlayerNames.length) {
          patch.pendingPlayerNames =
            stillPending.length > 0 ? stillPending : undefined;
        }
      }
      if (existing.pendingTeamNames && existing.pendingTeamNames.length > 0) {
        const stillPending = existing.pendingTeamNames.filter(
          (n) => !resolvedTeamNames.has(n.trim()),
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
    // (reviewByKey's `enrichment`, seeded in the prelude). Delete this batch's
    // now-consumed entityReviewQueue rows here, in the same transaction that
    // finishes the commit — the ids were read in the prelude to resolve
    // decisions, so this adds writes only, no extra reads. Deliberately NOT
    // scheduled async (the original design): a scheduled cleanup left a real
    // race — a re-fetch of the same selectorOptionId landing in the gap
    // between this returning and the scheduled delete actually running would
    // find every row already decided and wrongly resume the dead batch
    // (startBatch) instead of starting fresh. Deleting inline closes that
    // window: by the time the commit returns, the batch's rows are gone.
    for (const id of args.reviewRowIds) {
      await ctx.db.delete(id);
    }

    // NEO-147: enrich the career teams created by resolveTeamIdByName in the
    // prelude. Deliberately NOT the reviewed teams in `createdTeamIds` — those
    // already carry whatever processEntityReviewQueue's lookupTeamEnrichment
    // found before they were inserted, so re-running it here would be a second
    // identical network round-trip per team for the same answer. Only the rows
    // that had no enrichment path at all are enqueued.
    //
    // NEO-99 routed this through the shared Wikidata pool
    // (convex/wikidataPool.ts), which replaced the self-paced
    // processEnrichmentQueue: the pool's deployment-wide 5-parallel SPARQL
    // budget is what keeps a fetch that creates fifty career teams from
    // producing fifty concurrent requests. No `playerIds` because players
    // created there were already enriched from the wizard's own preview.
    //
    // NEO-203 — this satisfies `enqueueEnrichment`'s CREATION-ONLY contract,
    // and the reason is worth stating rather than leaving to be re-derived:
    // `enrichmentTeamIds` is appended to at exactly one place in the prelude,
    // the branch of `resolveTeamIdByName` immediately after
    // `ctx.db.insert("teams", …)`. A team the lookup FOUND returns early and
    // is never added. So this list is, structurally, "teams this commit
    // created" — never a pre-existing row. Automatic enrichment must never
    // fire for a team that already exists (Jason, 2026-09-02: team data
    // generally doesn't change); if you ever widen what feeds this list,
    // that invariant is what you are breaking.
    if (args.enrichmentTeamIds.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.wikidataPool.enqueueEnrichment,
        { teamIds: args.enrichmentTeamIds },
      );
    }

    // NEO-90: same chained-queue shape, for BSC per-card team resolution.
    // Cards whose team wasn't already recoverable from the bulk `players`
    // string (parsePlayersField's TC/parenthetical handling) get resolved
    // one at a time via BSC's per-card detail endpoint in the background.
    if (args.bscTeamEnrichmentIds.length > 0) {
      await ctx.scheduler.runAfter(
        0,
        internal.adapters.buysportscards.processBscTeamEnrichmentQueue,
        { cardChecklistIds: args.bscTeamEnrichmentIds },
      );
    }

    // NEO-24/38: harvest the locally-observable card-count from the BSC/SL
    // checklist fetch onto the setName ancestor's `totalCardCount` feature.
    // Only when this commit is itself happening AT the setName level —
    // otherwise this is a variant/insert/parallel fetch and our card count is
    // a subset, not the set total. releaseDate/block are purely manual (no
    // auto-harvest) and live in the same features map, independently editable
    // at every level via setSelectorOptionFeature.
    if (
      args.setNameAncestorId &&
      args.selectorOptionId === args.setNameAncestorId
    ) {
      const setNameRow = await ctx.db.get(args.setNameAncestorId);
      if (setNameRow) {
        const newCount = String(args.cardCount);
        if (setNameRow.features?.totalCardCount !== newCount) {
          await ctx.db.patch(args.setNameAncestorId, {
            features: { ...(setNameRow.features ?? {}), totalCardCount: newCount },
            lastUpdated: Date.now(),
          });
        }
      }
    }

    return {
      variationsLinked,
      operatorDeleted: deletedIds.length,
      deleteSkipped,
      unmatchedExistingIds,
    };
  },
});

/**
 * NEO-203 — decide, for every incoming card, WHICH existing row it is an
 * update to (if any). The whole of the matching fix lives in this function.
 *
 * ## Why not cardNumber
 *
 * Card numbers are not unique at any scope. Not across the source sets one NB
 * variant fans out to (BSC splits 1996 Score Dugout Collection Artist's Proofs
 * into two series and numbers both #1-110), and not even within one set — a
 * 2025 release ships a veteran #1 and a rookie #1, two distinct cards that are
 * not variations of each other. Keying on it merged unrelated cards on every
 * re-sync, silently and without changing the row count.
 *
 * ## The cascade
 *
 * 1. `bsc.ref`, then `sportlots.ref` — the stable linkage identity, and what
 *    the rest of the codebase already links on (NEO-137). If the two refs on
 *    ONE incoming card point at DIFFERENT stored rows, that is a genuine
 *    contradiction: the card is excluded from the commit entirely and
 *    reported. Choosing a side would corrupt one row; inserting would create
 *    the duplicate this ticket exists to prevent.
 * 2. `(side, slot, cardNumber)`. This is what survives the one thing a ref
 *    cannot: a SportLots ref IS the card description (NEO-91), so an upstream
 *    description fix changes it. The slot comes from the parent row's ATTACHED
 *    sets only, resolved through `slotBySetId` — an incoming `setId` string is
 *    never compared against a stored `src`. A card with NO `setId` skips this
 *    tier entirely rather than falling back to the primary slot the way
 *    `resolveCardSlots` does when WRITING: that fallback is right for
 *    attributing a card, and wrong here, because it would widen matching
 *    across exactly the duplicate-number case the tier is guarded against.
 * 3. Bare `cardNumber`, against rows carrying NO ref on either side — custom
 *    cards and pre-NEO-137 legacy rows, which have no other identity.
 *
 * Tiers 2 and 3 match only when the key is held by exactly one existing row
 * AND named by exactly one incoming card. Any ambiguity is a non-match, and
 * non-matches are surfaced, never guessed.
 *
 * ## Collisions
 *
 * Two incoming cards resolving to one stored row: the first keeps it, the
 * second becomes an insert carrying a `ref-collision` attribute marker so the
 * ambiguity is visible in the checklist rather than latent until someone
 * reads a log. Never a silent merge — that IS the bug.
 */
type IncomingMatchCard = {
  cardNumber: string;
  platformData?: WirePlatformData;
};

type MatchResolution = {
  /** Incoming index → the stored row it updates. Absent means insert. */
  existingIdByIndex: Array<Id<"cardChecklist"> | undefined>;
  /** Indices excluded from the commit: the card's two refs disagree. */
  conflicts: Array<{
    index: number;
    cardNumber: string;
    bscRowId: Id<"cardChecklist">;
    slRowId: Id<"cardChecklist">;
  }>;
  /** Indices that lost a collision and became inserts. */
  collisions: Array<{
    index: number;
    cardNumber: string;
    existingId: Id<"cardChecklist">;
  }>;
  /** Per-tier match counts, for the commit log. */
  matchedByTier: { bscRef: number; slRef: number; slotNumber: number; noRef: number };
  /**
   * Indices of cards that ended up UNMATCHED, and would not have if a key had
   * been unambiguous — either because several stored rows hold the key (it was
   * withheld from the map) or because several incoming cards claim it while a
   * stored row does hold it.
   *
   * Empty unless `withheld` is supplied. This is the difference between
   * "ambiguity EXISTS in this checklist" and "ambiguity CHANGED an outcome",
   * and only the second is worth telling an operator about — see
   * `WithheldMatchKeys`. A set whose fallback keys repeat by design but whose
   * every card carries a ref reports nothing here, correctly.
   */
  ambiguityBlocked: number[];
};

function resolveExistingIds(
  cards: IncomingMatchCard[],
  prelude: Pick<
    CommitPrelude,
    | "existingIdByBscRef"
    | "existingIdBySlRef"
    | "existingIdBySlotNumber"
    | "existingIdByNumberNoRef"
    | "slotBySetId"
  >,
  /**
   * The raw keys `buildMatchMaps` withheld. Optional because the commit path
   * receives its maps back from the prelude MUTATION, which only carries the
   * bounded/truncated log form across that boundary — see the note there. The
   * review query builds both in one process and passes this, which is what
   * lets it say something true about ambiguity instead of something alarming.
   */
  withheld?: WithheldMatchKeys,
): MatchResolution {
  const byBscRef = new Map(
    prelude.existingIdByBscRef.map(({ ref, id }) => [ref, id] as const),
  );
  const bySlRef = new Map(
    prelude.existingIdBySlRef.map(({ ref, id }) => [ref, id] as const),
  );
  const bySlotNumber = new Map(
    prelude.existingIdBySlotNumber.map(({ key, id }) => [key, id] as const),
  );
  const byNumberNoRef = new Map(
    prelude.existingIdByNumberNoRef.map(
      ({ cardNumber, id }) => [cardNumber, id] as const,
    ),
  );
  const slotBySetId = new Map(
    prelude.slotBySetId.map(
      ({ side, setId, slot }) => [`${side} ${setId}`, slot] as const,
    ),
  );

  // The slot key an incoming card claims on one side, or undefined when this
  // tier does not apply to it.
  const incomingSlotKey = (
    card: IncomingMatchCard,
    side: MatchSide,
  ): string | undefined => {
    const wire = card.platformData?.[side];
    if (!wire?.setId) return undefined;
    const slot = slotBySetId.get(`${side} ${wire.setId}`);
    if (!slot) return undefined;
    return slotNumberMatchKey(side, slot, card.cardNumber);
  };

  // How many INCOMING cards claim each number-based key. A key two incoming
  // cards share cannot identify one stored row either, so it is as ambiguous
  // from this direction as from the stored side.
  const incomingSlotKeyCount = new Map<string, number>();
  const incomingNumberCount = new Map<string, number>();
  for (const card of cards) {
    for (const side of MATCH_SIDES) {
      const key = incomingSlotKey(card, side);
      if (key) {
        incomingSlotKeyCount.set(key, (incomingSlotKeyCount.get(key) ?? 0) + 1);
      }
    }
    incomingNumberCount.set(
      card.cardNumber,
      (incomingNumberCount.get(card.cardNumber) ?? 0) + 1,
    );
  }

  const existingIdByIndex: Array<Id<"cardChecklist"> | undefined> = [];
  const conflicts: MatchResolution["conflicts"] = [];
  const collisions: MatchResolution["collisions"] = [];
  const matchedByTier = { bscRef: 0, slRef: 0, slotNumber: 0, noRef: 0 };
  const ambiguityBlocked: number[] = [];
  const claimed = new Set<string>();

  /**
   * Did ambiguity — rather than the card simply being new — cost this card a
   * match? Asked ONLY of cards the cascade left unmatched.
   *
   * Two directions, and both need a stored row to have existed, or there was
   * nothing to lose:
   *
   *   STORED side — the key is in `withheld`, meaning several stored rows hold
   *   it, so it was kept out of the map rather than guessed at.
   *   INCOMING side — several cards in THIS payload claim the key, and the map
   *   does hold a row for it. Without the map check this would fire on every
   *   duplicate-numbered new card, which is the false alarm being fixed.
   */
  const blockedByAmbiguity = (card: IncomingMatchCard): boolean => {
    if (!withheld) return false;
    const bscRef = card.platformData?.bsc?.ref;
    if (bscRef && withheld.bscRef.has(bscRef)) return true;
    const slRef = card.platformData?.sportlots?.ref;
    if (slRef && withheld.slRef.has(slRef)) return true;
    for (const side of MATCH_SIDES) {
      const key = incomingSlotKey(card, side);
      if (!key) continue;
      if (withheld.slotNumber.has(key)) return true;
      if ((incomingSlotKeyCount.get(key) ?? 0) > 1 && bySlotNumber.has(key)) {
        return true;
      }
    }
    const number = card.cardNumber;
    if (withheld.numberNoRef.has(number)) return true;
    if (
      (incomingNumberCount.get(number) ?? 0) > 1 &&
      byNumberNoRef.has(number)
    ) {
      return true;
    }
    return false;
  };

  cards.forEach((card, index) => {
    const bscRef = card.platformData?.bsc?.ref;
    const slRef = card.platformData?.sportlots?.ref;
    const bscRowId = bscRef ? byBscRef.get(bscRef) : undefined;
    const slRowId = slRef ? bySlRef.get(slRef) : undefined;

    if (bscRowId && slRowId && bscRowId !== slRowId) {
      conflicts.push({ index, cardNumber: card.cardNumber, bscRowId, slRowId });
      existingIdByIndex.push(undefined);
      return;
    }

    let matched: Id<"cardChecklist"> | undefined;
    let tier: keyof typeof matchedByTier | undefined;
    if (bscRowId) {
      matched = bscRowId;
      tier = "bscRef";
    } else if (slRowId) {
      matched = slRowId;
      tier = "slRef";
    } else {
      for (const side of MATCH_SIDES) {
        const key = incomingSlotKey(card, side);
        if (!key) continue;
        if ((incomingSlotKeyCount.get(key) ?? 0) !== 1) continue;
        const candidate = bySlotNumber.get(key);
        if (!candidate) continue;
        matched = candidate;
        tier = "slotNumber";
        break;
      }
      if (!matched && (incomingNumberCount.get(card.cardNumber) ?? 0) === 1) {
        const candidate = byNumberNoRef.get(card.cardNumber);
        if (candidate) {
          matched = candidate;
          tier = "noRef";
        }
      }
    }

    if (matched && claimed.has(matched)) {
      collisions.push({ index, cardNumber: card.cardNumber, existingId: matched });
      existingIdByIndex.push(undefined);
      return;
    }
    if (matched) {
      claimed.add(matched);
      if (tier) matchedByTier[tier]++;
    } else if (withheld && blockedByAmbiguity(card)) {
      // Only reached for a card that found NO row. A card that matched on a
      // ref does not care that some fallback key it never consulted repeats.
      ambiguityBlocked.push(index);
    }
    existingIdByIndex.push(matched);
  });

  return {
    existingIdByIndex,
    conflicts,
    collisions,
    matchedByTier,
    ambiguityBlocked,
  };
}

// ─── NEO-203 phase C: the content-diff review ──────────────────────────────

/** One changed NB-owned field, as the review renders it. */
const syncDiffFieldValidator = v.object({
  /** A member of `NB_CONTENT_FIELDS`. */
  name: v.string(),
  /** 1 = trust-critical, 2 = substantive-or-cosmetic. See NB_CONTENT_FIELD_TIER. */
  tier: v.number(),
  oldValue: v.string(),
  newValue: v.string(),
  /**
   * Which marketplace this card came from. Per-CARD, not per-field: the
   * BSC↔SportLots merge happens client-side in `CardPairingModal.mergePair`
   * and does not record which side won each field, so a per-field claim would
   * be a guess dressed as provenance.
   */
  source: v.union(
    v.literal("bsc"),
    v.literal("sportlots"),
    v.literal("both"),
    v.literal("none"),
  ),
  /**
   * Do the two values fold to the same thing under `nameKey` — i.e. is this a
   * reformatting rather than a rewrite? Drives the default checkbox state.
   */
  foldEqual: v.boolean(),
});

const syncDiffValidator = v.object({
  cards: v.array(
    v.object({
      /** Index into the `cards` argument, so the caller can address it back. */
      index: v.number(),
      cardNumber: v.string(),
      cardName: v.string(),
      bucket: v.union(
        v.literal("identical"),
        v.literal("formattingOnly"),
        v.literal("contentChanges"),
        v.literal("new"),
      ),
      existingId: v.optional(v.id("cardChecklist")),
      /** The matched row's `lastUpdated` as of this diff — the card's `baseVersion`. */
      baseVersion: v.optional(v.number()),
      fields: v.array(syncDiffFieldValidator),
    }),
  ),
  /**
   * Existing non-custom rows no incoming card matched, split by whether their
   * absence is actually evidence of removal — see the handler.
   */
  removedUpstream: v.object({
    fullyOrphaned: v.array(
      v.object({
        id: v.id("cardChecklist"),
        cardNumber: v.string(),
        cardName: v.string(),
        sides: v.array(v.union(v.literal("bsc"), v.literal("sportlots"))),
      }),
    ),
    partialOrphanCount: v.number(),
  }),
  /** Cards whose two refs point at two different NB rows. */
  conflicts: v.array(
    v.object({
      index: v.number(),
      cardNumber: v.string(),
      cardName: v.string(),
      bsc: v.object({
        rowId: v.id("cardChecklist"),
        cardNumber: v.string(),
        cardName: v.string(),
      }),
      sportlots: v.object({
        rowId: v.id("cardChecklist"),
        cardNumber: v.string(),
        cardName: v.string(),
      }),
    }),
  ),
  /** Cards that lost a match collision and will be inserted as their own row. */
  collisionInsertCount: v.number(),
  /**
   * How many incoming cards were left unmatched BECAUSE a match key was
   * ambiguous — not how many ambiguous keys exist.
   *
   * The distinction is the whole field. A variant fanned out across two
   * marketplace series repeats its `(side, slot, number)` fallback keys by
   * design, so "ambiguous keys exist" is the normal state of exactly the sets
   * this feature serves; it says nothing about whether any card suffered for
   * it. This counts cards that actually did — the only version of the fact an
   * operator can act on. See `WithheldMatchKeys`.
   *
   * A COUNT, never the keys: they embed marketplace refs (a SportLots ref is
   * the whole card description) and have no business crossing to a browser.
   */
  ambiguityBlockedCount: v.number(),
});

/**
 * NEO-203 phase C — what a re-sync would CHANGE, computed server-side.
 *
 * ## Why a query and not fields on `checklistCandidates`
 *
 * The obvious alternative was to thread the diff onto the streamed candidate
 * rows, which already carry every card to the client. It is wrong for one
 * decisive reason: a candidate row is PRE-PAIRING. `CardPairingModal` merges a
 * BSC row and a SportLots row into ONE card (`mergePair`), lets the operator
 * settle a name conflict, hand-link two singles, and discard everything left
 * over. The card whose content the operator must review is the merged,
 * confirmed one — which does not exist until Confirm is pressed, and is not
 * any single candidate row. Diffing candidates would show the operator a
 * comparison against a card that is never written.
 *
 * There is also nothing left to stream by this point: pairing is confirmed,
 * the whole confirmed set is in hand, and the next steps (entity review,
 * commit) are already imperative one-shot calls. So this is a one-shot query
 * called from `CardChecklist`'s pipeline between pairing and the entity
 * wizard, and `checklistCandidates` needs no new fields at all — the least
 * churn of the two options.
 *
 * ## Why it is server-side
 *
 * A client-computed diff would be a claim about rows the client cannot see,
 * and `commitCardChecklist` would then be trusting the operator's browser
 * about which stored row an incoming card is. It matches with
 * `buildMatchMaps` + `resolveExistingIds` — literally the same two functions
 * the commit runs — so what the operator reviews is what the commit will
 * match. `baseVersion` is the matched row's `lastUpdated` AT THIS INSTANT; the
 * chunk re-checks it inside its own writing transaction, so a row that moves
 * between review and commit applies nothing and is reported.
 *
 * ## Player and team fields are diffed BY NAME
 *
 * A stored row holds `playerIds`/`teamOnCardIds`; an incoming card holds
 * names, and the ids it would resolve to do not exist yet — `EntityReviewWizard`
 * creates them AFTER this step. Resolving names to ids here would therefore be
 * both wrong (the answer changes before the commit) and expensive (one indexed
 * lookup per distinct name). Names are also what an operator can actually
 * judge. The commit re-diffs on IDS before writing, so a disagreement between
 * the two views can only ever DROP a write, never add one.
 *
 * ## Bounded
 *
 * `assertCardBatchWithinLimits` caps the payload; the reads are one
 * `by_selector_option` collect plus one `db.get` per DISTINCT player/team id on
 * MATCHED rows only.
 */
export const diffChecklistAgainstExisting = query({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    cards: v.array(previewCardValidator),
  },
  returns: syncDiffValidator,
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    assertCardBatchWithinLimits(args.cards, "diffChecklistAgainstExisting");

    const leafNode = await ctx.db.get(args.selectorOptionId);
    const existingCards = await ctx.db
      .query("cardChecklist")
      .withIndex("by_selector_option", (q) =>
        q.eq("selectorOptionId", args.selectorOptionId),
      )
      .collect();

    // The SAME two functions the commit runs. See `buildMatchMaps`. Unlike the
    // commit, this runs in ONE process, so it can hand the cascade the raw
    // withheld keys and learn whether ambiguity actually cost any card a match.
    const { maps: matchMaps, withheld } = buildMatchMaps(
      existingCards,
      leafNode,
    );
    const match = resolveExistingIds(args.cards, matchMaps, withheld);

    const rowById = new Map<string, Doc<"cardChecklist">>();
    for (const row of existingCards) rowById.set(row._id, row);

    const matchedIds = new Set<string>();
    for (const id of match.existingIdByIndex) if (id) matchedIds.add(id);

    // Names for the entity ids on MATCHED rows only — deduped, so a 900-card
    // set costs at most one read per distinct player and team it references,
    // not one per card.
    const neededPlayerIds = new Set<string>();
    const neededTeamIds = new Set<string>();
    for (const id of matchedIds) {
      const row = rowById.get(id);
      if (!row) continue;
      for (const p of row.playerIds ?? []) neededPlayerIds.add(p);
      for (const t of row.teamOnCardIds ?? []) neededTeamIds.add(t);
    }
    const playerNameById = new Map<string, string>();
    for (const id of neededPlayerIds) {
      const doc = await ctx.db.get(id as Id<"players">);
      if (doc) playerNameById.set(id, doc.name);
    }
    const teamNameById = new Map<string, string>();
    for (const id of neededTeamIds) {
      const doc = await ctx.db.get(id as Id<"teams">);
      if (doc) teamNameById.set(id, doc.name);
    }
    // A dangling id is data the operator needs to SEE, not silently drop: a
    // vanished player must not make a card look like it agrees with upstream.
    const nameOf = (map: Map<string, string>, id: string) =>
      map.get(id) ?? "(missing)";

    const conflictIndices = new Set(match.conflicts.map((c) => c.index));

    const cards: Array<{
      index: number;
      cardNumber: string;
      cardName: string;
      bucket: "identical" | "formattingOnly" | "contentChanges" | "new";
      existingId?: Id<"cardChecklist">;
      baseVersion?: number;
      fields: Array<{
        name: string;
        tier: number;
        oldValue: string;
        newValue: string;
        source: "bsc" | "sportlots" | "both" | "none";
        foldEqual: boolean;
      }>;
    }> = [];

    args.cards.forEach((c, index) => {
      // A conflicted card is reported on its own below; it is not a diff, it
      // is a question about identity that has to be settled first.
      if (conflictIndices.has(index)) return;

      const hasBsc = !!c.platformData.bsc?.ref;
      const hasSl = !!c.platformData.sportlots?.ref;
      const source: "bsc" | "sportlots" | "both" | "none" =
        hasBsc && hasSl ? "both" : hasBsc ? "bsc" : hasSl ? "sportlots" : "none";

      const existingId = match.existingIdByIndex[index];
      const row = existingId ? rowById.get(existingId) : undefined;
      if (!row) {
        cards.push({
          index,
          cardNumber: c.cardNumber,
          cardName: c.cardName,
          bucket: "new",
          fields: [],
        });
        return;
      }

      const storedPlayers = (row.playerIds ?? []).map((id) =>
        nameOf(playerNameById, id),
      );
      const storedTeams = (row.teamOnCardIds ?? []).map((id) =>
        nameOf(teamNameById, id),
      );
      const incomingPlayers = (c.players ?? [])
        .map((p) => p.trim())
        .filter(Boolean);
      // Same precedence the commit action uses to build `teamOnCardIds`.
      const incomingTeamSources = c.teams?.length
        ? c.teams
        : c.team
          ? [c.team]
          : [];
      const incomingTeams = incomingTeamSources
        .map((t) => t.trim())
        .filter(Boolean);
      // The commit merges an `unmatched-<side>` marker into `attributes` for a
      // deliberately-kept single-marketplace card, so the diff has to compare
      // against the same value the chunk would write — otherwise every kept
      // single would show a permanent, un-actionable attributes change.
      const incomingAttributes = c.unmatched
        ? Array.from(
            new Set([...(c.attributes ?? []), `unmatched-${c.unmatched}`]),
          )
        : c.attributes;

      const comparisons: Array<{
        name: NbContentField;
        stored: unknown;
        incoming: unknown;
      }> = [
        { name: "cardName", stored: row.cardName, incoming: c.cardName },
        { name: "playerIds", stored: storedPlayers, incoming: incomingPlayers },
        {
          name: "teamOnCardIds",
          stored: storedTeams,
          incoming: incomingTeams,
        },
        {
          name: "attributes",
          stored: row.attributes,
          incoming: incomingAttributes,
        },
        { name: "isRookie", stored: row.isRookie, incoming: c.isRookie },
        { name: "isRelic", stored: row.isRelic, incoming: c.isRelic },
        { name: "printRun", stored: row.printRun, incoming: c.printRun },
        {
          name: "autographType",
          stored: row.autographType,
          incoming: c.autographType,
        },
        {
          name: "cardVariation",
          stored: row.cardVariation,
          incoming: c.cardVariation,
        },
      ];

      const fields = comparisons
        .filter(({ stored, incoming }) => !sameContentValue(stored, incoming))
        .map(({ name, stored, incoming }) => {
          const oldValue = displayContentValue(stored);
          const newValue = displayContentValue(incoming);
          return {
            name,
            tier: NB_CONTENT_FIELD_TIER[name],
            oldValue,
            newValue,
            source,
            foldEqual: nameKey(oldValue) === nameKey(newValue),
          };
        });

      cards.push({
        index,
        cardNumber: c.cardNumber,
        cardName: c.cardName,
        bucket:
          fields.length === 0
            ? "identical"
            : fields.every((f) => f.foldEqual)
              ? "formattingOnly"
              : "contentChanges",
        existingId: row._id,
        baseVersion: row.lastUpdated,
        fields,
      });
    });

    // ── What upstream no longer lists ───────────────────────────────────────
    //
    // A row is deletion-ELIGIBLE only when its absence is actually evidence
    // that it was removed. Two things can produce an unmatched row that was
    // NOT removed, and both must stay out of the delete list:
    //
    //  1. The side it is linked to did not come back. `fetchCardChecklist`
    //     tolerates a single-side failure, so a SportLots outage makes every
    //     SL-linked row look orphaned. A side counts as COVERED only if at
    //     least one incoming card carries a ref on it.
    //  2. Its identity is contested — its ref appears in a cross-side conflict
    //     or it lost a match collision. Upstream still names it; what is
    //     unresolved is which row that name belongs to.
    //
    // A row linked to BOTH sides where only one came back is exactly the
    // spec's PARTIAL orphan: still live on one marketplace, so it gets a
    // lighter treatment in the checklist, never a delete prompt.
    const coveredSides: Record<MatchSide, boolean> = {
      bsc: false,
      sportlots: false,
    };
    for (const c of args.cards) {
      if (c.platformData.bsc?.ref) coveredSides.bsc = true;
      if (c.platformData.sportlots?.ref) coveredSides.sportlots = true;
    }
    const contested = new Set<string>();
    for (const cf of match.conflicts) {
      contested.add(cf.bscRowId);
      contested.add(cf.slRowId);
    }
    for (const col of match.collisions) contested.add(col.existingId);

    const fullyOrphaned: Array<{
      id: Id<"cardChecklist">;
      cardNumber: string;
      cardName: string;
      sides: MatchSide[];
    }> = [];
    let partialOrphanCount = 0;
    for (const row of existingCards) {
      // Custom cards are NeonBinder's own and have no upstream that could have
      // dropped them — the finalize phase refuses to delete one either way.
      if (row.isCustom) continue;
      if (matchedIds.has(row._id)) continue;
      const linked = MATCH_SIDES.filter((s) => !!row.platformData?.[s]?.ref);
      // A row with no ref on either side (custom-shaped legacy data) has no
      // linkage evidence at all, so its absence proves nothing.
      const eligible =
        linked.length > 0 &&
        linked.every((s) => coveredSides[s]) &&
        !contested.has(row._id);
      if (eligible) {
        fullyOrphaned.push({
          id: row._id,
          cardNumber: row.cardNumber,
          cardName: row.cardName,
          sides: linked,
        });
      } else {
        partialOrphanCount++;
      }
    }
    fullyOrphaned.sort((a, b) => compareCardNumbers(a.cardNumber, b.cardNumber));

    return {
      cards,
      removedUpstream: { fullyOrphaned, partialOrphanCount },
      conflicts: match.conflicts.map((cf) => {
        const bscRow = rowById.get(cf.bscRowId);
        const slRow = rowById.get(cf.slRowId);
        return {
          index: cf.index,
          cardNumber: cf.cardNumber,
          cardName: args.cards[cf.index]?.cardName ?? "",
          bsc: {
            rowId: cf.bscRowId,
            cardNumber: bscRow?.cardNumber ?? "",
            cardName: bscRow?.cardName ?? "",
          },
          sportlots: {
            rowId: cf.slRowId,
            cardNumber: slRow?.cardNumber ?? "",
            cardName: slRow?.cardName ?? "",
          },
        };
      }),
      collisionInsertCount: match.collisions.length,
      ambiguityBlockedCount: match.ambiguityBlocked.length,
    };
  },
});

// ─── NEO-203 phase E: pre-merge data audit ─────────────────────────────────

/**
 * Row caps for the audit below.
 *
 * A Convex query may read ~16k documents, so the two scans together have to
 * stay comfortably inside that. These numbers are ~4x the largest real
 * checklist (a 908-card set) and well past the current catalog's node count;
 * if either scan truncates, the report says so rather than quietly reporting a
 * partial answer as a clean bill of health.
 */
const AUDIT_CARD_SCAN_LIMIT = 8000;
const AUDIT_NODE_SCAN_LIMIT = 4000;
const AUDIT_SAMPLE_LIMIT = 20;

/**
 * NEO-203 phase E — the pre-merge verification sweep.
 *
 * ## What it is for, and when it stops being useful
 *
 * NEO-203 changes what a re-sync keys on: from `cardNumber` (which is not
 * unique at any scope) to the marketplace REF, with number-based tiers behind
 * it that only fire when the answer is unarguable. Existing data was written
 * under the old rule, so before the change ships this answers the three
 * questions that decide how much of it heals on its own:
 *
 *   1. **Ref-less non-custom rows.** These can only ever match on tier 3 (bare
 *      card number against no-ref rows), so they are the rows most exposed to
 *      the old bug's residue and the least able to heal on a re-sync.
 *   2. **Variants whose checklist holds duplicate card numbers.** Under the old
 *      keying these are exactly the rows that got merged into one another — one
 *      patched twice, another left stale. Under the new keying they are fine
 *      PROVIDED they carry refs, which is why (1) and (2) are read together.
 *   3. **Variants with more than one attached slot on a side.** The N:M sets
 *      (NEO-189 attaches several marketplace sets to one variant), which is
 *      what makes duplicate numbers routine rather than exotic. These are the
 *      at-risk sets to re-sync first and eyeball.
 *
 * Run by an operator, on dev and then prod:
 *
 *   npx convex run selectorOptions:auditChecklistDataForResync '{}'
 *
 * `internalQuery` deliberately: this is an operator tool with no UI and no
 * client caller, and `internal` is the only access rule that cannot be got at
 * from a browser at all. It is also read-only — it reports, it never repairs.
 *
 * It returns COUNTS plus bounded samples, never whole rows: the point is to
 * size the problem, and a marketplace ref is unbounded upstream text that has
 * no business being echoed back in bulk.
 *
 * SAFE TO DELETE once NEO-203 has been verified on prod. It has no callers in
 * the application and nothing depends on its shape.
 */
/**
 * NEO-211 G — size the id-keyed re-sync BEFORE it runs anywhere real.
 *
 * The new matcher prefers marketplace id over display name. That is strictly
 * better going forward, but it only works on rows that HAVE an id: a row
 * written before NEO-137, or one whose side never linked, falls through to the
 * tier-2 name match. This query answers the three questions that decide
 * whether the first forced sync after deploy is boring:
 *
 *  1. How many non-custom rows carry no id on a side? Those are the rows that
 *     depend on tier 2 — if the marketplace also renamed them, they will
 *     insert a sibling rather than match.
 *  2. Do any siblings already fold to the same name? Tier 2 WITHHOLDS on those
 *     (it never picks), so they are the rows that will silently not update.
 *  3. Is any marketplace id held by more than one sibling? That is legal
 *     (NEO-137 M:1) but tier 1 withholds on it, so those rows fall to tier 2
 *     as well.
 *
 * Run against dev before merge and against prod before the first forced sync.
 * Internal: it is an operator instrument, not a feature.
 *
 * A FULL-TABLE WALK, capped — none of these predicates is over an indexed key,
 * and adding an index for a one-off pre-merge check would outlive the check.
 * Asking for one row past the cap is how truncation is detected, and the report
 * says so out loud rather than passing a partial scan off as a clean result.
 */
export const auditSelectorOptionsForResync = internalQuery({
  args: {},
  returns: v.object({
    scanned: v.object({
      selectorOptionRows: v.number(),
      truncated: v.boolean(),
    }),
    byLevel: v.array(
      v.object({
        level: levelValidator,
        rows: v.number(),
        nonCustomRows: v.number(),
        // (1) non-custom rows with no marketplace id on that side at all.
        missingBsc: v.number(),
        missingSportlots: v.number(),
        // (2) sibling groups (same level+parent) where >1 row folds to one name.
        valueCollisionGroups: v.number(),
        // (3) (side, id, parent) combinations held by more than one sibling.
        sharedMarketplaceIds: v.number(),
      }),
    ),
    samples: v.object({
      missingId: v.array(
        v.object({
          id: v.id("selectorOptions"),
          level: levelValidator,
          value: v.string(),
          side: platformSideValidator,
        }),
      ),
      valueCollision: v.array(
        v.object({
          level: levelValidator,
          parentId: v.optional(v.id("selectorOptions")),
          key: v.string(),
          rowCount: v.number(),
        }),
      ),
      sharedId: v.array(
        v.object({
          level: levelValidator,
          parentId: v.optional(v.id("selectorOptions")),
          side: platformSideValidator,
          marketplaceId: v.string(),
          rowCount: v.number(),
        }),
      ),
    }),
  }),
  handler: async (ctx) => {
    const nodeRows = await ctx.db
      .query("selectorOptions")
      .take(AUDIT_NODE_SCAN_LIMIT + 1);
    const truncated = nodeRows.length > AUDIT_NODE_SCAN_LIMIT;
    const nodes = truncated
      ? nodeRows.slice(0, AUDIT_NODE_SCAN_LIMIT)
      : nodeRows;

    type LevelStats = {
      level: Level;
      rows: number;
      nonCustomRows: number;
      missingBsc: number;
      missingSportlots: number;
      valueCollisionGroups: number;
      sharedMarketplaceIds: number;
    };
    const stats = new Map<Level, LevelStats>();
    const statsFor = (level: Level): LevelStats => {
      let s = stats.get(level);
      if (!s) {
        s = {
          level,
          rows: 0,
          nonCustomRows: 0,
          missingBsc: 0,
          missingSportlots: 0,
          valueCollisionGroups: 0,
          sharedMarketplaceIds: 0,
        };
        stats.set(level, s);
      }
      return s;
    };

    const missingIdSamples: Array<{
      id: Id<"selectorOptions">;
      level: Level;
      value: string;
      side: "bsc" | "sportlots";
    }> = [];

    // Sibling group → what is in it. Keyed the way the matcher scopes itself:
    // (level, parentId). A collision across two different parents is not a
    // collision at all, because no store call ever sees both.
    const groupKey = (row: Doc<"selectorOptions">) =>
      `${row.level} ${row.parentId ?? ""}`;
    const nameCounts = new Map<string, Map<string, number>>();
    const idCounts = new Map<string, Map<string, number>>();

    for (const node of nodes) {
      const level = node.level as Level;
      const s = statsFor(level);
      s.rows++;
      if (!node.isCustom) {
        s.nonCustomRows++;
        for (const side of ["bsc", "sportlots"] as const) {
          if (slotIds(node, side).length > 0) continue;
          if (side === "bsc") s.missingBsc++;
          else s.missingSportlots++;
          if (missingIdSamples.length < AUDIT_SAMPLE_LIMIT) {
            missingIdSamples.push({
              id: node._id,
              level,
              value: node.value,
              side,
            });
          }
        }
      }

      const gk = groupKey(node);
      let names = nameCounts.get(gk);
      if (!names) {
        names = new Map();
        nameCounts.set(gk, names);
      }
      const nk = selectorValueKey(node.value);
      names.set(nk, (names.get(nk) ?? 0) + 1);

      let ids = idCounts.get(gk);
      if (!ids) {
        ids = new Map();
        idCounts.set(gk, ids);
      }
      for (const side of ["bsc", "sportlots"] as const) {
        for (const id of slotIds(node, side)) {
          const key = `${side} ${id}`;
          ids.set(key, (ids.get(key) ?? 0) + 1);
        }
      }
    }

    // Re-derive the group's level/parent from the first row that produced it,
    // so samples are addressable without re-walking the table.
    const groupMeta = new Map<
      string,
      { level: Level; parentId?: Id<"selectorOptions"> }
    >();
    for (const node of nodes) {
      const gk = groupKey(node);
      if (!groupMeta.has(gk)) {
        groupMeta.set(gk, {
          level: node.level as Level,
          ...(node.parentId ? { parentId: node.parentId } : {}),
        });
      }
    }

    const valueCollisionSamples: Array<{
      level: Level;
      parentId?: Id<"selectorOptions">;
      key: string;
      rowCount: number;
    }> = [];
    for (const [gk, names] of nameCounts) {
      const meta = groupMeta.get(gk);
      if (!meta) continue;
      for (const [key, count] of names) {
        if (count <= 1) continue;
        statsFor(meta.level).valueCollisionGroups++;
        if (valueCollisionSamples.length < AUDIT_SAMPLE_LIMIT) {
          valueCollisionSamples.push({
            level: meta.level,
            ...(meta.parentId ? { parentId: meta.parentId } : {}),
            key,
            rowCount: count,
          });
        }
      }
    }

    const sharedIdSamples: Array<{
      level: Level;
      parentId?: Id<"selectorOptions">;
      side: "bsc" | "sportlots";
      marketplaceId: string;
      rowCount: number;
    }> = [];
    for (const [gk, ids] of idCounts) {
      const meta = groupMeta.get(gk);
      if (!meta) continue;
      for (const [key, count] of ids) {
        if (count <= 1) continue;
        statsFor(meta.level).sharedMarketplaceIds++;
        if (sharedIdSamples.length < AUDIT_SAMPLE_LIMIT) {
          const [side, marketplaceId] = key.split(" ");
          sharedIdSamples.push({
            level: meta.level,
            ...(meta.parentId ? { parentId: meta.parentId } : {}),
            side: side as "bsc" | "sportlots",
            marketplaceId,
            rowCount: count,
          });
        }
      }
    }

    return {
      scanned: { selectorOptionRows: nodes.length, truncated },
      byLevel: [...stats.values()],
      samples: {
        missingId: missingIdSamples,
        valueCollision: valueCollisionSamples,
        sharedId: sharedIdSamples,
      },
    };
  },
});

export const auditChecklistDataForResync = internalQuery({
  args: {},
  returns: v.object({
    scanned: v.object({
      cardChecklistRows: v.number(),
      selectorOptionRows: v.number(),
      // True when a scan hit its cap, so every count below is a LOWER BOUND.
      truncated: v.boolean(),
    }),
    // (1) Non-custom rows with no ref on either side.
    reflessCards: v.object({
      count: v.number(),
      samples: v.array(
        v.object({
          selectorOptionId: v.id("selectorOptions"),
          cardNumber: v.string(),
        }),
      ),
    }),
    // (2) Variants whose checklist repeats a card number.
    duplicateCardNumbers: v.object({
      variantCount: v.number(),
      samples: v.array(
        v.object({
          selectorOptionId: v.id("selectorOptions"),
          // How many DISTINCT numbers are held by more than one row here.
          duplicateNumberCount: v.number(),
        }),
      ),
    }),
    // (3) Rows with more than one attached marketplace set on a side.
    multiSlotVariants: v.object({
      count: v.number(),
      samples: v.array(
        v.object({
          selectorOptionId: v.id("selectorOptions"),
          bscSlots: v.number(),
          sportlotsSlots: v.number(),
        }),
      ),
    }),
  }),
  handler: async (ctx) => {
    // A FULL-TABLE WALK, capped. There is no index that answers "every row
    // lacking a ref" or "every node with two slots" — both predicates are over
    // field CONTENTS, not over an indexed key — and adding indexes to the
    // schema for a one-off pre-merge check would outlive the check. `take`
    // bounds the read; asking for one row past the cap is how truncation is
    // detected, and the report says so out loud rather than passing a partial
    // scan off as a clean result.
    const cardRows = await ctx.db
      .query("cardChecklist")
      .take(AUDIT_CARD_SCAN_LIMIT + 1);
    const cardsTruncated = cardRows.length > AUDIT_CARD_SCAN_LIMIT;
    const cards = cardsTruncated
      ? cardRows.slice(0, AUDIT_CARD_SCAN_LIMIT)
      : cardRows;

    const nodeRows = await ctx.db
      .query("selectorOptions")
      .take(AUDIT_NODE_SCAN_LIMIT + 1);
    const nodesTruncated = nodeRows.length > AUDIT_NODE_SCAN_LIMIT;
    const nodes = nodesTruncated
      ? nodeRows.slice(0, AUDIT_NODE_SCAN_LIMIT)
      : nodeRows;

    // (1) + (2), from the one card scan.
    let reflessCount = 0;
    const reflessSamples: Array<{
      selectorOptionId: Id<"selectorOptions">;
      cardNumber: string;
    }> = [];
    const numbersByVariant = new Map<string, Map<string, number>>();
    for (const row of cards) {
      // Custom cards have no upstream and are expected to carry no ref, so
      // counting them here would bury the rows that actually matter.
      if (!row.isCustom) {
        const hasRef =
          !!row.platformData?.bsc?.ref || !!row.platformData?.sportlots?.ref;
        if (!hasRef) {
          reflessCount++;
          if (reflessSamples.length < AUDIT_SAMPLE_LIMIT) {
            reflessSamples.push({
              selectorOptionId: row.selectorOptionId,
              cardNumber: row.cardNumber,
            });
          }
        }
      }
      // Duplicate numbers count CUSTOM rows too: a custom card sharing a number
      // with a marketplace card is exactly the collision the old keying merged.
      const key = row.selectorOptionId as string;
      let counts = numbersByVariant.get(key);
      if (!counts) {
        counts = new Map<string, number>();
        numbersByVariant.set(key, counts);
      }
      counts.set(row.cardNumber, (counts.get(row.cardNumber) ?? 0) + 1);
    }

    let duplicateVariantCount = 0;
    const duplicateSamples: Array<{
      selectorOptionId: Id<"selectorOptions">;
      duplicateNumberCount: number;
    }> = [];
    for (const [variantId, counts] of numbersByVariant) {
      let duplicateNumberCount = 0;
      for (const n of counts.values()) if (n > 1) duplicateNumberCount++;
      if (duplicateNumberCount === 0) continue;
      duplicateVariantCount++;
      if (duplicateSamples.length < AUDIT_SAMPLE_LIMIT) {
        duplicateSamples.push({
          selectorOptionId: variantId as Id<"selectorOptions">,
          duplicateNumberCount,
        });
      }
    }

    // (3), from the node scan. Read through `slotIds` — the same helper every
    // slot-aware path uses — so "an attached set" means here exactly what it
    // means at write time.
    let multiSlotCount = 0;
    const multiSlotSamples: Array<{
      selectorOptionId: Id<"selectorOptions">;
      bscSlots: number;
      sportlotsSlots: number;
    }> = [];
    for (const node of nodes) {
      const bscSlots = slotIds(node, "bsc").length;
      const sportlotsSlots = slotIds(node, "sportlots").length;
      if (bscSlots <= 1 && sportlotsSlots <= 1) continue;
      multiSlotCount++;
      if (multiSlotSamples.length < AUDIT_SAMPLE_LIMIT) {
        multiSlotSamples.push({
          selectorOptionId: node._id,
          bscSlots,
          sportlotsSlots,
        });
      }
    }

    return {
      scanned: {
        cardChecklistRows: cards.length,
        selectorOptionRows: nodes.length,
        truncated: cardsTruncated || nodesTruncated,
      },
      reflessCards: { count: reflessCount, samples: reflessSamples },
      duplicateCardNumbers: {
        variantCount: duplicateVariantCount,
        samples: duplicateSamples,
      },
      multiSlotVariants: {
        count: multiSlotCount,
        samples: multiSlotSamples,
      },
    };
  },
});

/**
 * Commit a fetched checklist preview. Every player/team name that isn't
 * already in our tables was reviewed one-at-a-time in the NEO-92 review wizard
 * (batchId → entityReviewQueue), which recorded a `decision` of "create"
 * (seeded from the wizard's own Wikidata preview lookup) or "link" (an
 * existing player/team the user picked instead — no new row). There is no
 * skip: every name resolves to one or the other. Card playerIds/teamOnCardIds
 * are resolved from those decisions, the checklist is persisted, and the
 * batch's review rows are cleaned up.
 *
 * ## Why this is an ACTION and not a mutation (NEO-189)
 *
 * It was a single mutation, and it died on real data. A 712-card commit failed
 * on the PR #205 Convex preview with `Your request timed out performing too
 * many system operations.` (request af06962bc3db7994); a 335-card commit passed
 * but already sat near its wait budget. NEO-189 attaches several marketplace
 * sets to one variant (SportLots "Base Set" + "Base Set Series 2" + BSC), which
 * is precisely what doubles a checklist — so the ceiling is not hypothetical,
 * it is the feature.
 *
 * The cost was structural: per card the handler did an insert plus a SKU patch,
 * a `db.get` per playerId, then two more full passes doing `db.get`/`patch` per
 * stored id — ~5-6 database operations per card, ~4000 in one transaction.
 * Convex bounds a single mutation at 1s execution, 4096 index ranges read, 32k
 * documents scanned and 16k written, plus the system-operation time budget that
 * actually tripped. Tightening the loop does not buy another 2x; the
 * transaction has to be split.
 *
 * Same shape as `resetSetBuilderData` above — a public entry point looping
 * internal mutations, each its own transaction:
 *
 *   prelude  → once. Admin check, sport row, player/team creation from the
 *              review decisions, leaf features, setName ancestor, and the
 *              pre-commit snapshot the upsert keys against.
 *   chunk    → once per CARDS_PER_COMMIT_CHUNK cards. Pure writer.
 *   finalize → once, over the union of every chunk's ids: variation links,
 *              the operator's explicit deletes, the unmatched-existing report,
 *              sortOrder, review cleanup, schedules.
 *
 * ## ATOMICITY IS LOST — read this before adding a phase
 *
 * A mutation was all-or-nothing. This is not. A failure during chunk N leaves
 * chunks 1..N-1 written, chunk N+1.. unwritten, and the finalize phase
 * (operator deletes, variation links, sortOrder fixups, review-row cleanup,
 * background enrichment) NOT run. The checklist is then a partial copy of the
 * preview with none of its whole-commit bookkeeping applied.
 *
 * Re-running the same commit is the recovery, and it is STILL safe under
 * NEO-203's ref keying — for a better reason than the number keying gave.
 *
 * The old claim was "cards upsert by number, so already-written rows are
 * patched rather than duplicated". That held only as far as numbers were
 * unique, which they are not. What holds now: a chunk INSERTS a row with the
 * incoming card's `platformData` already on it, refs included
 * (`toStoredPlatformData` keeps the ref whether or not a slot resolves). So
 * every row the interrupted run managed to insert is in the next run's prelude
 * snapshot AND carries the same ref the payload will send again — and refs are
 * stable within one commit's payload, because it is the same payload. Tier 1
 * of the cascade therefore matches each re-sent card to the exact row the
 * interrupted run created for it. No duplicates, and no dependence on card
 * numbers being distinct.
 *
 * Two consequences worth stating plainly. Those re-matched rows are then
 * treated as MATCHED rows, so the re-run refreshes their linkage and applies
 * content only where `applyFields` says to — which is correct, since the
 * interrupted run inserted them with full content already. And the finalize
 * phase no longer sweeps: what an interrupted run left behind that the re-run
 * does not match is REPORTED (`unmatchedExistingIds`), not deleted. Recovery
 * is complete, but tidying is an operator decision like every other deletion.
 *
 * The errors this action throws name the phase that failed — "which cards made
 * it" is answerable from the phase and chunk index.
 *
 * What must NOT be added to a chunk: anything that deletes, anything that reads
 * the commit as a whole, anything whose partial application is worse than not
 * running. Those belong in finalize, which is one transaction and therefore
 * still atomic in itself.
 */
export const commitCardChecklist = action({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    sportId: v.id("selectorOptions"),
    // NEO-203: each card may carry the operator's per-field accept decision
    // (`applyFields` + `baseVersion`). Absent on every caller that predates
    // the review UI, which is what makes this additive.
    cards: v.array(commitCardValidator),
    // Present whenever the fetch surfaced unknown names (and the wizard
    // ran); absent on the zero-unknowns fast path.
    batchId: v.optional(v.string()),
    // NEO-203: rows the operator explicitly chose to delete. A marketplace
    // dropping a card never deletes anything on its own — see the note on
    // `commitCardChecklistFinalize`.
    operatorDeleteIds: v.optional(v.array(v.id("cardChecklist"))),
  },
  returns: v.object({
    success: v.boolean(),
    count: v.number(),
    createdPlayerIds: v.array(v.id("players")),
    createdTeamIds: v.array(v.id("teams")),
    // ── NEO-203: what the operator has to know about this commit ───────────
    // Rows present in NeonBinder that no incoming card matched — the cards
    // that vanished upstream. Reported, never deleted.
    unmatchedExistingCount: v.number(),
    // Cards excluded from the commit because their BSC and SportLots refs
    // point at two different NB rows. Neither guessing nor inserting is safe,
    // so the card is not written at all until an operator resolves it.
    conflicts: v.array(
      v.object({
        cardNumber: v.string(),
        bscRowId: v.id("cardChecklist"),
        slRowId: v.id("cardChecklist"),
      }),
    ),
    // Cards that lost a match collision and were inserted as new rows instead.
    collisionInserts: v.number(),
    // Matched rows whose accepted content was withheld because the row moved
    // between the operator's review and the write.
    staleDecisions: v.number(),
    operatorDeleted: v.number(),
  }),
  handler: async (ctx, args): Promise<{
    success: boolean;
    count: number;
    createdPlayerIds: Array<Id<"players">>;
    createdTeamIds: Array<Id<"teams">>;
    unmatchedExistingCount: number;
    conflicts: Array<{
      cardNumber: string;
      bscRowId: Id<"cardChecklist">;
      slRowId: Id<"cardChecklist">;
    }>;
    collisionInserts: number;
    staleDecisions: number;
    operatorDeleted: number;
  }> => {
    // Enforced HERE, before any phase runs, so a non-admin call writes
    // nothing at all — the phases below re-check, but this is the boundary.
    await requireAdmin(ctx);
    // Still the cap on the TOTAL commit, not on a chunk. Chunking raises the
    // per-transaction ceiling, not the per-commit one: the prelude is still
    // O(distinct names) in a single transaction.
    assertCardBatchWithinLimits(args.cards, "commitCardChecklist");
    // Checked before ANY phase writes, so an over-long delete list costs the
    // operator nothing. Finalize re-checks — it is separately callable.
    const operatorDeleteIds = args.operatorDeleteIds ?? [];
    if (operatorDeleteIds.length > MAX_OPERATOR_DELETE_IDS) {
      throw new ConvexError(
        `commitCardChecklist: ${operatorDeleteIds.length} operatorDeleteIds exceeds the ${MAX_OPERATOR_DELETE_IDS} limit for a single commit`,
      );
    }

    // Run one phase: retry an optimistic-concurrency conflict a bounded number
    // of times, then rethrow labelled with the phase that failed.
    //
    // WHY THE RETRY (NEO-189). The prelude reads a whole `entityReviewQueue`
    // batch, and the Wikidata pool's lookups were still landing on those rows
    // while it read — so the commit lost the OCC race on Convex's every
    // internal retry and the seed job went red. The real fix is upstream:
    // `applyLookupResult` and the completion backstop now no-op on a row that
    // already carries a decision, so the contending write does not happen at
    // all. This is the belt-and-braces behind it, for a straggler that was
    // already in flight before its own guard could see the decision. An
    // OCC-failed mutation rolled back completely, so re-running a phase starts
    // from the state it started from the first time — see lib/errors/occ-retry.
    //
    // Every phase gets it, chunks included. A chunk is the phase where a
    // conflict hurts MOST: a prelude failure writes nothing, but a chunk
    // failure leaves a partial commit with the finalize sweep unrun (see the
    // atomicity note above). `cardChecklist` rows have their own background
    // writer — `processBscTeamEnrichmentQueue` from a previous sync — so this
    // is not hypothetical there either.
    //
    // WHY ConvexError AND NOT Error. Production redacts a plain `Error` thrown
    // from a Convex function down to "Server Error"; only a ConvexError's
    // string `data` crosses to the client intact. A phase label the operator
    // cannot read on prod is not a phase label. See
    // lib/errors/user-facing-message.ts, which is what the client reads it
    // back with.
    const phase = async <T>(label: string, run: () => Promise<T>): Promise<T> => {
      try {
        return await runWithOccRetry(run);
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new ConvexError(
          `commitCardChecklist: ${label} failed — ${detail}`,
        );
      }
    };

    const playerNames: string[] = [];
    const teamNames: string[] = [];
    for (const c of args.cards) {
      for (const p of c.players ?? []) if (p.trim()) playerNames.push(p.trim());
      for (const t of c.teams ?? []) if (t.trim()) teamNames.push(t.trim());
      if (c.team && c.team.trim() && !c.teams?.length) teamNames.push(c.team.trim());
    }

    const prelude: CommitPrelude = await phase("prelude", () =>
      ctx.runMutation(internal.selectorOptions.commitCardChecklistPrelude, {
        selectorOptionId: args.selectorOptionId,
        sportId: args.sportId,
        playerNames: Array.from(new Set(playerNames)),
        teamNames: Array.from(new Set(teamNames)),
        batchId: args.batchId,
      }),
    );

    const playerIdByName = new Map(
      prelude.playerIdByName.map(({ name, id }) => [name, id] as const),
    );
    const teamIdByName = new Map(
      prelude.teamIdByName.map(({ name, id }) => [name, id] as const),
    );
    const playerNameById = new Map(
      prelude.playerNameById.map(({ id, name }) => [id as string, name] as const),
    );
    const teamNameById = new Map(
      prelude.teamNameById.map(({ id, name }) => [id as string, name] as const),
    );
    // ── NEO-203: which existing row each incoming card updates ──────────────
    const match = resolveExistingIds(args.cards, prelude);
    const conflictIndices = new Set(match.conflicts.map((c) => c.index));
    const collisionIndices = new Set(match.collisions.map((c) => c.index));

    // Cards excluded from the commit are excluded from EVERYTHING that follows
    // — sort ordering, the committed-number set, the chunk payloads — because
    // nothing is being written for them. Their original indices are carried
    // along so variation resolution below still speaks in whole-payload terms.
    const committed = args.cards
      .map((card, index) => ({ card, index }))
      .filter(({ index }) => !conflictIndices.has(index));

    // Pre-compute the target sortOrder for every card that will be in this
    // selectorOption after the upsert: incoming cards (marketplace) PLUS
    // preserved custom cards (existing rows with isCustom=true that are not
    // being overwritten by a new marketplace card with the same cardNumber).
    // Sort by natural cardNumber so custom cards like "9001" land after
    // marketplace cards "1".."335". Done in-memory in the action — every chunk
    // and the finalize phase are handed the answer, so no phase has to re-read
    // the table to agree with the others about ordering.
    const incomingNumbers = new Set(committed.map(({ card }) => card.cardNumber));
    const preservedCustomNumbers = prelude.existingCustomCardNumbers.filter(
      (cn) => !incomingNumbers.has(cn),
    );
    const allFinalNumbers: string[] = [
      ...committed.map(({ card }) => card.cardNumber),
      ...preservedCustomNumbers,
    ];
    allFinalNumbers.sort(compareCardNumbers);
    const targetSortOrder = new Map<string, number>();
    allFinalNumbers.forEach((cn, idx) => targetSortOrder.set(cn, idx));

    // Resolve per-card playerIds / teamOnCardIds. Cards whose names are
    // all unresolved end up with empty arrays (left undefined).
    const chunkCards = committed.map(({ card: c, index }) => {
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
      // Reconciliation markers live in `attributes` so they are visible on the
      // card itself, not only in a log. NEO-203 adds `ref-collision`: this
      // card resolved to a row another incoming card had already claimed, so
      // it was inserted as its own row instead. The marker is what makes that
      // discoverable on the NEXT sync rather than latent forever.
      const markers = [
        ...(c.unmatched ? [`unmatched-${c.unmatched}`] : []),
        ...(collisionIndices.has(index) ? ["ref-collision"] : []),
      ];
      return {
        originalIndex: index,
        card: {
          cardNumber: c.cardNumber,
          cardName: c.cardName,
          // NEO-26: legacy `team` no longer emitted. The free-text string
          // from the adapter is consumed above to resolve teamOnCardIds[];
          // it isn't written to cardChecklist anywhere.
          playerIds: playerIds.length ? playerIds : undefined,
          teamOnCardIds: teamOnCardIds.length ? teamOnCardIds : undefined,
          attributes: markers.length
            ? Array.from(new Set([...(c.attributes ?? []), ...markers]))
            : c.attributes,
          isRookie: c.isRookie,
          isRelic: c.isRelic,
          printRun: c.printRun,
          autographType: c.autographType,
          cardVariation: c.cardVariation,
          // NEO-137: WIRE shape here (marketplace set ids); the chunk resolves
          // it to slots so a stored card's `src` always names a slot on its own
          // parent row.
          platformData: c.platformData,
          sortOrder: targetSortOrder.get(c.cardNumber) ?? index,
          playerNames: playerIds
            .map((id) => playerNameById.get(id as string))
            .filter((n): n is string => n !== undefined),
          // NEO-101: in the same stored order as `teamOnCardIds`, so the title
          // names teams the way the card does.
          teamNames: teamOnCardIds
            .map((id) => teamNameById.get(id as string))
            .filter((n): n is string => n !== undefined),
          existingId: match.existingIdByIndex[index],
          // NEO-203: the operator's per-field decision travels with the card.
          // The chunk validates the names, re-checks `baseVersion` against the
          // row inside its own transaction, and re-diffs before writing — so
          // nothing here is trusted, it is only proposed.
          applyFields: c.applyFields,
          baseVersion: c.baseVersion,
        },
      };
    });

    // NEO-189: card index → the row's stored id. Filled chunk by chunk, and
    // consumed below to resolve variation parents — which is the whole reason
    // the links are computed HERE rather than inside a chunk: a child in chunk
    // 3 can have its parent in chunk 1, and neither chunk can see the other.
    //
    // NEO-203: SPARSE, and indexed by the card's position in `args.cards`
    // rather than by its position in the chunk stream. A conflicted card is
    // never sent to a chunk, so the two are no longer the same sequence, and
    // variation resolution below speaks in whole-payload indices.
    const storedIdByIndex: Array<Id<"cardChecklist"> | undefined> = new Array(
      args.cards.length,
    ).fill(undefined);
    const bscTeamEnrichmentIds: Array<Id<"cardChecklist">> = [];
    const staleDecisionIds: Array<Id<"cardChecklist">> = [];
    let contentAppliedCount = 0;
    const chunkCount = Math.ceil(chunkCards.length / CARDS_PER_COMMIT_CHUNK);
    for (let start = 0; start < chunkCards.length; start += CARDS_PER_COMMIT_CHUNK) {
      const slice = chunkCards.slice(start, start + CARDS_PER_COMMIT_CHUNK);
      const index = Math.floor(start / CARDS_PER_COMMIT_CHUNK) + 1;
      const result: {
        storedIds: Array<Id<"cardChecklist">>;
        bscTeamEnrichmentIds: Array<Id<"cardChecklist">>;
        staleDecisionIds: Array<Id<"cardChecklist">>;
        contentAppliedCount: number;
      } = await phase(
        `chunk ${index}/${chunkCount} (cards ${start + 1}-${start + slice.length} of ${chunkCards.length})`,
        () =>
          ctx.runMutation(internal.selectorOptions.commitCardChecklistChunk, {
            selectorOptionId: args.selectorOptionId,
            cards: slice.map(({ card }) => card),
            sportSkuCode: prelude.sportSkuCode,
            sportValue: prelude.sportValue,
            setNameValue: prelude.setNameValue,
            inheritedFeatures: prelude.inheritedFeatures,
          }),
      );
      // The chunk returns one stored id per card it was given, in order.
      slice.forEach(({ originalIndex }, i) => {
        storedIdByIndex[originalIndex] = result.storedIds[i];
      });
      bscTeamEnrichmentIds.push(...result.bscTeamEnrichmentIds);
      staleDecisionIds.push(...result.staleDecisionIds);
      contentAppliedCount += result.contentAppliedCount;
    }

    // ── NEO-189: which card varies which ────────────────────────────────────
    //
    // The grouping rule lives in lib/cards/variations.ts and is deliberately
    // not "a suffixed number belongs to the bare one" — 2021 Topps has no card
    // #1 at all, only 1a/1b/1c, and SportLots gives every variation of #13 the
    // number 13. What holds is: group by card-number stem, and the single row
    // in the group that is NOT a variation is the parent.
    //
    // `unresolvedStems` are groups where that fails — a stem with no
    // non-variation row (2021 Heritage inserts #251/#378, two checklist print
    // variations and no base card) or more than one. Those rows are left
    // unlinked rather than guessed at, and reported so the set builder can
    // surface them. Guessing here would silently marry two unrelated cards.
    //
    // NEO-203: run PER SOURCE SET, not over the merged payload. The rule
    // groups on the card-number stem alone, which lib/cards/variations.ts
    // states outright is sound only when the input covers ONE marketplace set:
    // across a fan-out, Bill Bonham's #29 variation lands in the same stem as
    // Deivi Garcia's #29 and links to it. That is structurally identical to
    // the legitimate different-player case (a Legend short print IS a
    // different player), so nothing downstream can tell them apart — only the
    // scoping can. Cards with no source attribution at all are their own
    // partition rather than being spread across the others.
    //
    // Indices stay GLOBAL: each partition is resolved on its own rows and the
    // results are translated back, so `parentByIndex` still indexes
    // `args.cards` and `variationClearIds` below stays a whole-list decision.
    const variationPartitions = new Map<string, number[]>();
    args.cards.forEach((c, i) => {
      const sourceKey =
        c.platformData?.bsc?.setId ??
        c.platformData?.sportlots?.setId ??
        "unattributed";
      const bucket = variationPartitions.get(sourceKey);
      if (bucket) bucket.push(i);
      else variationPartitions.set(sourceKey, [i]);
    });
    const variationLinks: {
      parentByIndex: Map<number, number>;
      unresolvedStems: string[];
    } = { parentByIndex: new Map(), unresolvedStems: [] };
    for (const indices of variationPartitions.values()) {
      const resolved = resolveVariationParents(
        indices.map((i) => ({
          cardNumber: args.cards[i].cardNumber,
          isVariation: !!args.cards[i].isVariation,
          variationLabel: args.cards[i].cardVariation,
        })),
      );
      for (const [child, parent] of resolved.parentByIndex) {
        variationLinks.parentByIndex.set(indices[child], indices[parent]);
      }
      // Not deduped across partitions: the same stem unresolved in two source
      // sets is two separate groups needing review, and collapsing them would
      // understate the work.
      variationLinks.unresolvedStems.push(...resolved.unresolvedStems);
    }
    const links: Array<{
      childId: Id<"cardChecklist">;
      parentId: Id<"cardChecklist">;
    }> = [];
    for (const [childIndex, parentIndex] of variationLinks.parentByIndex) {
      const childId = storedIdByIndex[childIndex];
      const parentId = storedIdByIndex[parentIndex];
      // A row no chunk stored has no id; skip rather than write a dangling
      // pointer.
      if (!childId || !parentId || childId === parentId) continue;
      links.push({ childId, parentId });
    }
    const variationClearIds: Array<Id<"cardChecklist">> = [];
    for (let i = 0; i < args.cards.length; i++) {
      if (variationLinks.parentByIndex.has(i)) continue;
      const id = storedIdByIndex[i];
      if (id) variationClearIds.push(id);
    }

    const committedIds = storedIdByIndex.filter(
      (id): id is Id<"cardChecklist"> => id !== undefined,
    );
    const { variationsLinked, operatorDeleted, unmatchedExistingIds } = await phase(
      "finalize",
      () =>
      ctx.runMutation(internal.selectorOptions.commitCardChecklistFinalize, {
        selectorOptionId: args.selectorOptionId,
        committedIds,
        committedNumbers: Array.from(incomingNumbers),
        operatorDeleteIds,
        variationLinks: links,
        variationClearIds,
        customSortOrders: preservedCustomNumbers.map((cardNumber) => ({
          cardNumber,
          sortOrder: targetSortOrder.get(cardNumber) ?? 0,
        })),
        resolvedPlayerNames: Array.from(playerIdByName.keys()),
        resolvedTeamNames: Array.from(teamIdByName.keys()),
        skippedPlayerNames: prelude.skippedPlayerNames,
        skippedTeamNames: prelude.skippedTeamNames,
        reviewRowIds: args.batchId ? prelude.reviewRowIds : [],
        enrichmentTeamIds: prelude.enrichmentTeamIds,
        bscTeamEnrichmentIds,
        setNameAncestorId: prelude.setNameAncestorId,
        cardCount: args.cards.length,
      }),
    );

    if (variationsLinked > 0 || variationLinks.unresolvedStems.length > 0) {
      console.log(
        JSON.stringify({
          msg: "commit_card_variations",
          selectorOptionId: args.selectorOptionId,
          variationsLinked,
          unresolvedStems: variationLinks.unresolvedStems.slice(0, 20),
          unresolvedStemCount: variationLinks.unresolvedStems.length,
        }),
      );
    }

    // ── NEO-203: one structured line per commit that had anything to say ────
    //
    // Counts are the operational signal; the bounded samples exist only to
    // make a problem recognisable. Ids and card numbers only — never a diffed
    // VALUE, and refs only via the already-truncated `ambiguousMatchKeys`.
    // None of this ever reaches a `ConvexError`, which crosses to the browser.
    const somethingToReport =
      match.conflicts.length > 0 ||
      match.collisions.length > 0 ||
      prelude.ambiguousMatchKeys.length > 0 ||
      staleDecisionIds.length > 0 ||
      unmatchedExistingIds.length > 0;
    if (somethingToReport) {
      console.log(
        JSON.stringify({
          msg: "commit_card_matching",
          selectorOptionId: args.selectorOptionId,
          incoming: args.cards.length,
          matchedByTier: match.matchedByTier,
          // Two refs on one card pointing at two different NB rows. Excluded
          // from the commit rather than guessed at or duplicated.
          conflictCount: match.conflicts.length,
          conflicts: match.conflicts.slice(0, 20).map((c) => ({
            cardNumber: c.cardNumber,
            bscRowId: c.bscRowId,
            slRowId: c.slRowId,
          })),
          // Two incoming cards resolving to one row: first won, second was
          // inserted with a `ref-collision` attribute marker.
          collisionCount: match.collisions.length,
          collisions: match.collisions.slice(0, 20).map((c) => ({
            cardNumber: c.cardNumber,
            existingId: c.existingId,
          })),
          // Keys the prelude withheld because several stored rows hold them.
          ambiguousKeyCount: prelude.ambiguousMatchKeys.length,
          ambiguousKeys: prelude.ambiguousMatchKeys.slice(0, 20),
          // Accepted content withheld: the row moved under the review.
          staleDecisionCount: staleDecisionIds.length,
          staleDecisionIds: staleDecisionIds.slice(0, 20),
          contentAppliedCount,
          // Rows upstream no longer lists. Reported only — a marketplace
          // dropping a card does not delete a NeonBinder row.
          unmatchedExistingCount: unmatchedExistingIds.length,
          unmatchedExistingIds: unmatchedExistingIds.slice(0, 20),
        }),
      );
    }

    return {
      success: true,
      // The cards this commit actually wrote. Equal to `args.cards.length`
      // whenever nothing was excluded, which is every commit with no ref
      // conflict — reporting the payload size instead would claim rows that
      // were deliberately not written.
      count: chunkCards.length,
      createdPlayerIds: prelude.createdPlayerIds,
      createdTeamIds: prelude.createdTeamIds,
      unmatchedExistingCount: unmatchedExistingIds.length,
      conflicts: match.conflicts.map((c) => ({
        cardNumber: c.cardNumber,
        bscRowId: c.bscRowId,
        slRowId: c.slRowId,
      })),
      collisionInserts: match.collisions.length,
      staleDecisions: staleDecisionIds.length,
      operatorDeleted,
    };
  },
});
