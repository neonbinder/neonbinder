import { action, mutation } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { getCurrentUserId, requireAdmin } from "./auth";

// ===== LEVEL VALIDATOR =====
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

// ===== MATCHING HELPERS =====

// Common marketplace abbreviations / aliases. Keys and values must be lowercase.
// Applied token-by-token after basic normalization so "Autos" → "autographs" etc.
const TOKEN_SYNONYMS: Record<string, string> = {
  auto: "autograph",
  autos: "autograph",
  rc: "rookie",
  rcs: "rookie",
  sp: "shortprint",
  sps: "shortprint",
  ssp: "supershortprint",
  ssps: "supershortprint",
  // Plural-normalize common suffix words so "autograph" / "autographs" collapse too
  autographs: "autograph",
  rookies: "rookie",
  inserts: "insert",
  parallels: "parallel",
  shortprints: "shortprint",
  supershortprints: "supershortprint",
  refractors: "refractor",
  prizms: "prizm",
  prisms: "prism",
  variations: "variation",
  variants: "variant",
  patches: "patch",
  relics: "relic",
  jerseys: "jersey",
  signatures: "signature",
};

// Words that take a simple "+s" plural. When a token ends in 's' and the
// trimmed singular is in this set, the singular form is used for matching.
// Lightweight, extensible alternative to listing each plural pair in
// TOKEN_SYNONYMS — add new singulars here as marketplaces surface them.
const PLURALIZABLE_WORDS: Set<string> = new Set(["prizm"]);

function singularize(tok: string): string {
  if (tok.length > 1 && tok.endsWith("s")) {
    const singular = tok.slice(0, -1);
    if (PLURALIZABLE_WORDS.has(singular)) return singular;
  }
  return tok;
}

function normalizeForMatch(s: string): string {
  const base = s
    .toLowerCase()
    .trim()
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, " ");
  if (!base) return base;
  return base
    .split(" ")
    .map((tok) => TOKEN_SYNONYMS[tok] ?? singularize(tok))
    .join(" ");
}

// Returns true when one normalized token-set is a subset of the other.
// Used as a guard on fuzzy matches so a single differing meaningful token
// (e.g. "red" vs "chrome") blocks the pair, while genuine super/subset
// relationships ("Topps Chrome Update" vs "Chrome Update") still match.
function tokensOf(s: string): Set<string> {
  return new Set(normalizeForMatch(s).split(" ").filter(Boolean));
}

function isTokenSubsetOrSuperset(a: string, b: string): boolean {
  const ta = tokensOf(a);
  const tb = tokensOf(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const [smaller, larger] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const tok of smaller) {
    if (!larger.has(tok)) return false;
  }
  return true;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
      }
    }
  }

  return dp[m][n];
}

type PlatformItem = { value: string; platformValue: string };

type MatchedPair = {
  displayName: string;
  bsc: PlatformItem;
  sl: PlatformItem;
  confidence: number;
};

// Strips a leading SL Base prefix from an SL value (case-insensitive,
// optional trailing whitespace) so matching can compare the variant tail
// against the BSC name. Returns the original string when the prefix
// doesn't lead — never lossy.
function stripSlBasePrefix(value: string, prefix: string): string {
  if (!prefix) return value;
  const v = value.trim();
  const p = prefix.trim();
  if (v.toLowerCase().startsWith(p.toLowerCase())) {
    return v.slice(p.length).trim();
  }
  return v;
}

function computeMatches(
  bscItems: PlatformItem[],
  slItems: PlatformItem[],
  slStripPrefix?: string,
): {
  autoMatched: MatchedPair[];
  unmatchedBsc: PlatformItem[];
  unmatchedSl: PlatformItem[];
} {
  const autoMatched: MatchedPair[] = [];
  const remainingBsc = [...bscItems];
  const remainingSl = [...slItems];

  // Stripped SL values used only for comparison; the original SL value is
  // preserved in the emitted pair so the UI shows the marketplace name.
  // Index-aligned with `remainingSl` and resliced together.
  const slStripped = remainingSl.map((sl) =>
    slStripPrefix ? stripSlBasePrefix(sl.value, slStripPrefix) : sl.value,
  );

  // Pass 1: Exact match on normalized strings
  for (let i = remainingBsc.length - 1; i >= 0; i--) {
    const bscNorm = normalizeForMatch(remainingBsc[i].value);
    const slIndex = remainingSl.findIndex(
      (_, j) => normalizeForMatch(slStripped[j]) === bscNorm,
    );
    if (slIndex !== -1) {
      autoMatched.push({
        displayName: remainingBsc[i].value,
        bsc: remainingBsc[i],
        sl: remainingSl[slIndex],
        confidence: 1.0,
      });
      remainingBsc.splice(i, 1);
      remainingSl.splice(slIndex, 1);
      slStripped.splice(slIndex, 1);
    }
  }

  // Pass 2: Bag-of-words match — same multiset of normalized tokens in any
  // order. Catches "Prizms Red" ↔ "Red Prizm" without leaning on fuzzy edit
  // distance (which fails when word swaps create many character-level
  // changes). Sorted-token join preserves duplicate-token semantics.
  const bagOf = (s: string): string =>
    normalizeForMatch(s).split(" ").filter(Boolean).sort().join(" ");
  for (let i = remainingBsc.length - 1; i >= 0; i--) {
    const bscBag = bagOf(remainingBsc[i].value);
    if (!bscBag) continue;
    const slIndex = remainingSl.findIndex(
      (_, j) => bagOf(slStripped[j]) === bscBag,
    );
    if (slIndex !== -1) {
      autoMatched.push({
        displayName: remainingBsc[i].value,
        bsc: remainingBsc[i],
        sl: remainingSl[slIndex],
        confidence: 0.95,
      });
      remainingBsc.splice(i, 1);
      remainingSl.splice(slIndex, 1);
      slStripped.splice(slIndex, 1);
    }
  }

  // Pass 3: Fuzzy match remaining with Levenshtein ratio < 0.40, but only
  // when the token sets stand in a subset/superset relationship. The
  // subset guard prevents single-meaningful-token mismatches ("red" vs
  // "chrome") from sneaking through; the looser char-ratio lets shorter
  // BSC names ("Aqua Lava Refractors") match their SL counterparts that
  // carry an extra brand-prefix token ("Chrome Aqua Lava Refractor").
  const MAX_RATIO = 0.4;
  for (let i = remainingBsc.length - 1; i >= 0; i--) {
    const bscNorm = normalizeForMatch(remainingBsc[i].value);
    let bestSlIndex = -1;
    let bestRatio = Infinity;

    for (let j = 0; j < remainingSl.length; j++) {
      const slNorm = normalizeForMatch(slStripped[j]);
      const maxLen = Math.max(bscNorm.length, slNorm.length);
      if (maxLen === 0) continue;
      const ratio = levenshteinDistance(bscNorm, slNorm) / maxLen;
      if (ratio < bestRatio) {
        bestRatio = ratio;
        bestSlIndex = j;
      }
    }

    if (
      bestSlIndex !== -1 &&
      bestRatio < MAX_RATIO &&
      isTokenSubsetOrSuperset(
        remainingBsc[i].value,
        slStripped[bestSlIndex],
      )
    ) {
      autoMatched.push({
        displayName: remainingBsc[i].value,
        bsc: remainingBsc[i],
        sl: remainingSl[bestSlIndex],
        confidence: 1 - bestRatio,
      });
      remainingBsc.splice(i, 1);
      remainingSl.splice(bestSlIndex, 1);
      slStripped.splice(bestSlIndex, 1);
    }
  }

  return {
    autoMatched,
    unmatchedBsc: remainingBsc,
    unmatchedSl: remainingSl,
  };
}

// ===== ACTIONS =====

export const fetchRawOptions = action({
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
    // Display name of the SL Base set (e.g. "Prizm Stars & Stripes").
    // When provided, the SL row whose value exactly matches is excluded
    // from slOptions (it's the parent set, not a variant), and the
    // prefix is stripped from remaining SL values before auto-matching
    // so "Prizm Stars & Stripes Blue Prizm" lines up against BSC's
    // "Prizms Blue".
    baseSlPrefix: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    bscOptions: v.array(v.object({ value: v.string(), platformValue: v.string() })),
    slOptions: v.array(v.object({ value: v.string(), platformValue: v.string() })),
    autoMatched: v.array(v.object({
      displayName: v.string(),
      bsc: v.object({ value: v.string(), platformValue: v.string() }),
      sl: v.object({ value: v.string(), platformValue: v.string() }),
      confidence: v.number(),
    })),
    unmatchedBsc: v.array(v.object({ value: v.string(), platformValue: v.string() })),
    unmatchedSl: v.array(v.object({ value: v.string(), platformValue: v.string() })),
    // Per-platform adapter failures surfaced as structured data so the UI
    // can show a "Sync failed" error and a Retry button when both option
    // lists come back empty due to an underlying failure (e.g. missing
    // Secret Manager creds → 404). Empty array means no adapter errors.
    errors: v.array(v.object({ platform: v.string(), message: v.string() })),
    message: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    try {
      const { level, parentId, parentFilters, baseSlPrefix } = args;

      console.log(
        `[fetchRawOptions] Fetching ${level} options with filters:`,
        parentFilters,
      );

      // Build platform-specific filters from the ancestor chain
      let slPlatformFilters: Record<string, string> | undefined;
      let bscPlatformFilters: Record<string, string[]> | undefined;
      const precondMissingBsc: string[] = [];

      if (parentId) {
        const chain = await ctx.runQuery(
          api.selectorOptions.getAncestorChain,
          { id: parentId },
        );

        // Uniform custom-subtree skip — the third and last sync backend to
        // get it (fetchAggregatedOptions + syncSetsAcrossManufacturers in
        // selectorOptions.ts already have it). A custom ancestor has no
        // marketplace presence, so BSC/SL must not be queried. Without this,
        // the custom node's missing BSC slug trips the precondition below and
        // surfaces a spurious "Sync failed: could not load …" on what should
        // be a clean skip → the form then routes empty+no-errors to onDone
        // (idle, "+ Custom"). Kept local (no cross-file import) per the
        // convention noted in selectorOptions.ts. See NEO-22 / NEO-47 Phase 3.
        if (chain.some((row) => row.isCustom === true)) {
          console.log(
            `[fetchRawOptions] custom subtree — skipping marketplace fetch for ${level}`,
          );
          return {
            success: true,
            bscOptions: [],
            slOptions: [],
            autoMatched: [],
            unmatchedBsc: [],
            unmatchedSl: [],
            errors: [],
            message: "Custom subtree — no marketplace variants to sync",
          };
        }

        slPlatformFilters = {};
        bscPlatformFilters = {};

        // Data-integrity precondition for BSC only. Missing BSC slugs at
        // sport/year/setName lead to under-filtered queries returning 0
        // results, which the form's empty-with-errors guard then surfaces
        // as a generic "could not load variants". Catch the missing slugs
        // here so the error names the actual broken level. SL is
        // intentionally not preconditioned — see fetchCardChecklist for
        // the rationale (SL has no setName-level concept).
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
            precondMissingBsc.push(`${lvl}=${ancestor.value}`);
          } else if (ancestor.value) {
            // Display-value fallback is only acceptable for levels that
            // are NOT in BSC_REQUIRED. The intent is to forward
            // manufacturer/variantType-style display values when no slug
            // mapping exists; for sport/year/setName we want a clean
            // precondition error instead of a silently-wrong filter.
            bscPlatformFilters[lvl] = [ancestor.value.toLowerCase()];
          }
        }

        console.log(
          `[fetchRawOptions] Resolved platform filters — SL:`,
          slPlatformFilters,
          `BSC:`,
          bscPlatformFilters,
        );
      }

      if (precondMissingBsc.length > 0) {
        const errs = [{
          platform: "bsc",
          message: `Missing platformData.bsc on: ${precondMissingBsc.join(", ")}`,
        }];
        console.error(
          `[fetchRawOptions] precondition failed:`,
          JSON.stringify(errs),
        );
        return {
          success: true,
          bscOptions: [],
          slOptions: [],
          autoMatched: [],
          unmatchedBsc: [],
          unmatchedSl: [],
          errors: errs,
          message: errs.map((e) => `${e.platform}: ${e.message}`).join("; "),
        };
      }

      let bscOptions: PlatformItem[] = [];
      let slOptions: PlatformItem[] = [];
      const platformErrors: Record<string, string> = {};

      // Fetch from SportLots
      try {
        const result = await ctx.runAction(
          api.adapters.sportlots.fetchSportLotsSelectorOptions,
          {
            level,
            parentFilters: parentFilters || {},
            ...(slPlatformFilters ? { platformFilters: slPlatformFilters } : {}),
          },
        );
        if (result.success && result.options) {
          // Drop the SL Base anchor row itself (e.g. "Prizm Stars & Stripes")
          // so it doesn't surface as a variant candidate downstream.
          slOptions = baseSlPrefix
            ? result.options.filter(
                (o) =>
                  o.value.trim().toLowerCase() !==
                  baseSlPrefix.trim().toLowerCase(),
              )
            : result.options;
        } else if (!result.success) {
          platformErrors.sportlots = result.message || "Unknown error";
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        platformErrors.sportlots = msg;
        console.error(`[fetchRawOptions] SportLots error:`, error);
      }

      // Fetch from BSC
      try {
        const result = await ctx.runAction(
          api.adapters.buysportscards.fetchBscSelectorOptions,
          {
            level,
            parentFilters: parentFilters || {},
            ...(bscPlatformFilters ? { platformFilters: bscPlatformFilters } : {}),
          },
        );
        if (result.success && result.options) {
          bscOptions = result.options;
        } else if (!result.success) {
          platformErrors.bsc = result.message || "Unknown error";
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        platformErrors.bsc = msg;
        console.error(`[fetchRawOptions] BSC error:`, error);
      }

      // Log adapter errors to PostHog
      if (Object.keys(platformErrors).length > 0) {
        let userId = "anonymous";
        try {
          userId = await getCurrentUserId(ctx) || "anonymous";
        } catch {
          // auth context may not be available
        }
        await ctx.runAction(internal.posthog.captureEvent, {
          distinctId: userId,
          event: "set_reconciliation_fetch_failed",
          properties: {
            level,
            platformErrors,
            parentFilters: parentFilters || {},
          },
        }).catch((err: unknown) => {
          console.error("[fetchRawOptions] Failed to send PostHog event:", err);
        });
      }

      // Run matching algorithm. The SL Base anchor is already filtered
      // out of slOptions above; passing baseSlPrefix here lets the matcher
      // compare BSC names against SL values with the prefix stripped.
      const { autoMatched, unmatchedBsc, unmatchedSl } = computeMatches(
        bscOptions,
        slOptions,
        baseSlPrefix,
      );

      const warningSuffix =
        Object.keys(platformErrors).length > 0
          ? ` (Warnings: ${Object.entries(platformErrors)
              .map(([plat, err]) => `${plat}: ${err}`)
              .join("; ")})`
          : "";

      const errors = Object.entries(platformErrors).map(([platform, message]) => ({
        platform,
        message,
      }));

      return {
        success: true,
        bscOptions,
        slOptions,
        autoMatched,
        unmatchedBsc,
        unmatchedSl,
        errors,
        message: `BSC: ${bscOptions.length}, SL: ${slOptions.length}, Auto-matched: ${autoMatched.length}${warningSuffix}`,
      };
    } catch (error) {
      console.error(`[fetchRawOptions] Error:`, error);
      return {
        success: false,
        bscOptions: [],
        slOptions: [],
        autoMatched: [],
        unmatchedBsc: [],
        unmatchedSl: [],
        errors: [
          {
            platform: "internal",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        ],
        message: `Failed to fetch options: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

// ===== MUTATIONS =====

// Normalize a platformData side (string | string[] | undefined) to an array.
function pdToArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

// Pack an ID list back into the canonical shape: undefined / string / string[].
function packIds(ids: string[]): string | string[] | undefined {
  if (ids.length === 0) return undefined;
  if (ids.length === 1) return ids[0];
  return ids;
}

// Returns true if a row carries operator-attached extras beyond the primary
// — i.e. would be destructive to delete during reconciliation cleanup.
function hasOperatorExtras(row: {
  platformData: { bsc?: string | string[]; sportlots?: string | string[] };
  primaryPlatformId?: { bsc?: string; sportlots?: string };
}): boolean {
  for (const side of ["bsc", "sportlots"] as const) {
    const ids = pdToArray(row.platformData[side]);
    const primary = row.primaryPlatformId?.[side] ?? ids[0];
    const extras = ids.filter((id) => id !== primary);
    if (extras.length > 0) return true;
  }
  return false;
}

export const storeReconciledOptions = mutation({
  args: {
    level: levelValidator,
    parentId: v.optional(v.id("selectorOptions")),
    reconciledItems: v.array(
      v.object({
        value: v.string(),
        platformData: v.object({
          bsc: v.optional(v.union(v.string(), v.array(v.string()))),
          sportlots: v.optional(v.union(v.string(), v.array(v.string()))),
        }),
        metadata: metadataValidator,
        // NEO-24: reconciler may seed set-level marketplace metadata
        // (release date, etc) when the data source provides it.
        // Merge-patched onto existing rows; features are NOT touched here
        // — those go through `setSelectorOptionFeature` so propagation
        // semantics stay centralized.
        setMetadata: v.optional(v.object({
          releaseDate: v.optional(v.string()),
          totalCardCount: v.optional(v.number()),
          block: v.optional(v.string()),
          tcdbSetId: v.optional(v.string()),
          sourceUrl: v.optional(v.string()),
          lastSyncedAt: v.optional(v.number()),
        })),
      }),
    ),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    optionsCount: v.number(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const { level, parentId, reconciledItems } = args;

    // Get existing options for this level and parent
    const existingOptions = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", level).eq("parentId", parentId),
      )
      .collect();

    const existingByValue = new Map<string, (typeof existingOptions)[0]>();
    for (const opt of existingOptions) {
      existingByValue.set(opt.value.toLowerCase().trim(), opt);
    }

    const processedValues = new Set<string>();
    const insertedIds: Id<"selectorOptions">[] = [];

    for (const item of reconciledItems) {
      const normalizedValue = item.value.toLowerCase().trim();
      processedValues.add(normalizedValue);

      const existing = existingByValue.get(normalizedValue);
      if (existing) {
        // Refresh-without-clobber (NEO-6): replace only the entry matching
        // the existing primaryPlatformId per side; keep operator-attached
        // extras and their labels. Always rewrite primaryPlatformId to the
        // reconciler's value so future re-reconciles continue to refresh
        // the right slot.
        const mergedPD: { bsc?: string | string[]; sportlots?: string | string[] } = {};
        const mergedLabels: {
          bsc?: Record<string, string>;
          sportlots?: Record<string, string>;
        } = {};
        const newPrimary: { bsc?: string; sportlots?: string } = {};

        for (const side of ["bsc", "sportlots"] as const) {
          const oldIds = pdToArray(existing.platformData[side]);
          const oldPrimary = existing.primaryPlatformId?.[side] ?? oldIds[0];
          const extras = oldIds.filter((id) => id !== oldPrimary);
          const reconciledIds = pdToArray(item.platformData[side]);
          const refreshedPrimary = reconciledIds[0];

          const merged = refreshedPrimary
            ? [refreshedPrimary, ...extras]
            : extras;
          mergedPD[side] = packIds(merged);
          if (refreshedPrimary) newPrimary[side] = refreshedPrimary;

          // Preserve labels for surviving extra IDs. Reconciler does not
          // produce labels (those come from the operator's attach dialog).
          const oldLabels = existing.platformLabels?.[side] ?? {};
          const survivingLabels: Record<string, string> = {};
          for (const id of extras) {
            if (oldLabels[id]) survivingLabels[id] = oldLabels[id];
          }
          if (Object.keys(survivingLabels).length > 0) {
            mergedLabels[side] = survivingLabels;
          }
        }

        const patch: Record<string, unknown> = {
          platformData: mergedPD,
          lastUpdated: Date.now(),
        };
        if (Object.keys(mergedLabels).length > 0) {
          patch.platformLabels = mergedLabels;
        } else if (existing.platformLabels !== undefined) {
          // Clear stale labels when no extras remain.
          patch.platformLabels = undefined;
        }
        // Always rewrite primaryPlatformId (or clear it). Convex patch is
        // a shallow merge at the top level, so replacing the whole object
        // also drops any side the reconciler no longer owns. Without this
        // a removed primary would linger and pose as the primary on the
        // next reconciliation pass.
        patch.primaryPlatformId =
          Object.keys(newPrimary).length > 0 ? newPrimary : undefined;
        if (item.metadata) {
          patch.metadata = { ...(existing.metadata || {}), ...item.metadata };
        }
        // NEO-24: merge-patch setMetadata if the reconciler supplied any.
        // Existing keys are preserved; new keys overlay them.
        if (item.setMetadata) {
          patch.setMetadata = {
            ...(existing.setMetadata || {}),
            ...item.setMetadata,
          };
        }
        await ctx.db.patch(existing._id, patch);
        insertedIds.push(existing._id);
      } else {
        // Fresh insert: reconciler is the only source of IDs, so its values
        // are the primary on both sides.
        const newPrimary: { bsc?: string; sportlots?: string } = {};
        const bscIds = pdToArray(item.platformData.bsc);
        const slIds = pdToArray(item.platformData.sportlots);
        if (bscIds[0]) newPrimary.bsc = bscIds[0];
        if (slIds[0]) newPrimary.sportlots = slIds[0];

        const id = await ctx.db.insert("selectorOptions", {
          level,
          value: item.value,
          platformData: item.platformData,
          ...(Object.keys(newPrimary).length > 0
            ? { primaryPlatformId: newPrimary }
            : {}),
          parentId,
          children: [],
          metadata: item.metadata,
          ...(item.setMetadata ? { setMetadata: item.setMetadata } : {}),
          lastUpdated: Date.now(),
        });
        insertedIds.push(id);
      }
    }

    // Delete old non-custom options that weren't in the reconciled set —
    // but preserve any row carrying operator-attached extras (NEO-6).
    // Reconciler-only rows are still deleted as before.
    if (reconciledItems.length > 0) {
      for (const existing of existingOptions) {
        const normalizedValue = existing.value.toLowerCase().trim();
        if (
          !processedValues.has(normalizedValue) &&
          !existing.isCustom &&
          !hasOperatorExtras(existing)
        ) {
          await ctx.db.delete(existing._id);
        }
      }
    }

    // Update parent's children array — keep insertedIds, plus any existing
    // row that wasn't deleted (custom rows OR operator-extras-preserved rows).
    if (parentId && insertedIds.length > 0) {
      const preservedIds = existingOptions
        .filter(
          (o) =>
            !processedValues.has(o.value.toLowerCase().trim()) &&
            (o.isCustom || hasOperatorExtras(o)),
        )
        .map((o) => o._id);
      await ctx.db.patch(parentId, {
        children: [...insertedIds, ...preservedIds],
      });
    }

    return {
      success: true,
      message: `Successfully stored ${insertedIds.length} reconciled ${level} options`,
      optionsCount: insertedIds.length,
    };
  },
});
