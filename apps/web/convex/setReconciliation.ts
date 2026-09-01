import { action, mutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { getCurrentUserId, requireAdmin } from "./auth";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";
import {
  hasOperatorExtras,
  slotIds,
  initialSlots,
  pruneEmptySides,
  setPrimarySlotId,
} from "./platformSlots";

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

/**
 * NEO-137: exported ONLY so `setReconciliation.computeMatches.test.ts` can pin
 * its behaviour. It is shared by Base, inserts and parallels across every set,
 * so its output is a far wider contract than any one feature.
 */
export function computeMatches(
  bscItems: PlatformItem[],
  slItems: PlatformItem[],
  slStripPrefix?: string,
): {
  autoMatched: MatchedPair[];
  unmatchedBsc: PlatformItem[];
  unmatchedSl: PlatformItem[];
  /** NEO-137 — see the block that builds this near the end of the function. */
  slCandidates: Array<{
    bsc: PlatformItem;
    candidates: Array<{
      sl: PlatformItem;
      confidence: number;
      alreadyMatched: boolean;
    }>;
  }>;
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

  // NEO-137: ranked candidates for the BSC rows that ended up with nothing.
  //
  // The three passes above splice each match out of BOTH arrays, so a
  // marketplace set that two NB rows should share is consumed by whichever
  // row matched first — that is how 1996 Score's Artist's Proofs Series 1 was
  // left unmatched while Series 2 took the single SL set at 78%.
  //
  // This scores every still-unmatched BSC row against EVERY SL item,
  // including ones already consumed by an auto-match, and reports the best
  // few. It is strictly additive: `autoMatched` / `unmatchedBsc` /
  // `unmatchedSl` above are untouched, so no set's reconciliation output
  // changes. The operator confirms a shared link explicitly — nothing here
  // links anything on its own, because the discriminator between two series
  // is not inferable (both can contain a card #1).
  const MAX_CANDIDATES = 5;
  const CANDIDATE_FLOOR = 0.3;
  const slCandidates = remainingBsc.map((bsc) => {
    const bscNorm = normalizeForMatch(bsc.value);
    const scored = slItems
      .map((sl) => {
        const compareAgainst = slStripPrefix
          ? stripSlBasePrefix(sl.value, slStripPrefix)
          : sl.value;
        const slNorm = normalizeForMatch(compareAgainst);
        const maxLen = Math.max(bscNorm.length, slNorm.length);
        if (maxLen === 0) return null;
        const confidence =
          1 - levenshteinDistance(bscNorm, slNorm) / maxLen;
        return {
          sl,
          confidence,
          // True when an auto-matched pair already claimed this SL set —
          // i.e. confirming this candidate creates the M:1 mapping.
          alreadyMatched: autoMatched.some(
            (p) => p.sl.platformValue === sl.platformValue,
          ),
        };
      })
      .filter((c): c is NonNullable<typeof c> => c !== null)
      .filter((c) => c.confidence >= CANDIDATE_FLOOR)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_CANDIDATES);
    return { bsc, candidates: scored };
  });

  return {
    autoMatched,
    unmatchedBsc: remainingBsc,
    unmatchedSl: remainingSl,
    slCandidates,
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
    // NEO-137: ranked SL candidates per still-unmatched BSC row, including
    // sets already claimed by an auto-match. `alreadyMatched` marks the ones
    // whose confirmation creates an M-NB-rows-to-1-marketplace-set mapping.
    // Offered only — the operator confirms, nothing links itself.
    slCandidates: v.array(v.object({
      bsc: v.object({ value: v.string(), platformValue: v.string() }),
      candidates: v.array(v.object({
        sl: v.object({ value: v.string(), platformValue: v.string() }),
        confidence: v.number(),
        alreadyMatched: v.boolean(),
      })),
    })),
    // Per-platform adapter failures surfaced as structured data so the UI
    // can show a "Sync failed" error and a Retry button when both option
    // lists come back empty due to an underlying failure (e.g. missing
    // Secret Manager creds → 404). Empty array means no adapter errors.
    errors: v.array(v.object({ platform: v.string(), message: v.string() })),
    message: v.optional(v.string()),
  }),
  // Explicit return type: without it, adding `slCandidates` pushed the
  // inferred type past TypeScript's inference budget and `fetchRawOptions`
  // silently degraded to `any` at every call site (implicit-any on
  // `result.autoMatched.map((m) => ...)` in AttachSetsDialog / VariantForm /
  // ParallelForm). `fetchCardChecklist` annotates its handler for the same
  // reason.
  handler: async (ctx, args): Promise<{
    success: boolean;
    bscOptions: PlatformItem[];
    slOptions: PlatformItem[];
    autoMatched: MatchedPair[];
    unmatchedBsc: PlatformItem[];
    unmatchedSl: PlatformItem[];
    slCandidates: Array<{
      bsc: PlatformItem;
      candidates: Array<{
        sl: PlatformItem;
        confidence: number;
        alreadyMatched: boolean;
      }>;
    }>;
    errors: Array<{ platform: string; message: string }>;
    message: string;
  }> => {
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
            slCandidates: [],
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
          // NEO-137: adapters speak marketplace IDs, not slots.
          const ancestorSlIds = slotIds(ancestor, "sportlots");
          if (ancestorSlIds.length > 0) {
            slPlatformFilters[lvl] = ancestorSlIds[0];
          }
          const ancestorBscIds = slotIds(ancestor, "bsc");
          if (ancestorBscIds.length > 0) {
            bscPlatformFilters[lvl] = ancestorBscIds;
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
          slCandidates: [],
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
      const { autoMatched, unmatchedBsc, unmatchedSl, slCandidates } =
        computeMatches(bscOptions, slOptions, baseSlPrefix);

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
        slCandidates,
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
        slCandidates: [],
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

/**
 * NEO-196 — candidate pools for the "Attach more source sets" dialog.
 *
 * `fetchRawOptions` above answers a different question: "what does each
 * marketplace offer at NB LEVEL X under NB PARENT Y". That is right for the
 * reconciler, which is walking the NeonBinder tree. It is wrong for the attach
 * dialog, which is trying to reach a marketplace set that is NOT under this
 * row's parent — the whole point of a multi-source row is that some of its
 * cards were released somewhere else (1996 Score DCAP split across two BSC
 * sets; 2021 Score's last 20 cards released in Chronicles).
 *
 * Two facts about the marketplaces drive the shape of these two actions, and
 * they are the reason a single "browse one NB level up" control could not work:
 *
 *   SportLots has no set/variant split at all. `dealsets.tpl` returns a FLAT
 *   list of sets for a sport+year+brand, and that list is both the browse
 *   surface and the attachable unit. It is reached at NB level "insert"
 *   (see LEVEL_TO_TARGET_SELECT / fetchSetNames in adapters/sportlots.ts);
 *   at "setName", "variantType" and "parallel" SL returns nothing at all.
 *   So SL needs no scope control: one call already yields every set under the
 *   year/manufacturer.
 *
 *   BSC does have the split — `setName` then `variantName` — and its facet
 *   API cannot enumerate variantNames with their owning set. So BSC needs two
 *   steps: list the year's sets, then list one set's variants. That is the
 *   "browse up to setName, then back down" the dialog renders.
 *
 * Both actions are deliberately scoped from the ROW, not from a client-supplied
 * level/parent pair, so the shared backend (web + mobile) has one honest entry
 * point per marketplace and callers cannot construct an incoherent request.
 */

type AttachContext = {
  /** Display values, for adapter `parentFilters`. */
  sport?: string;
  year?: string;
  manufacturer?: string;
  setName?: string;
  /** Marketplace ids resolved off the ancestor chain. */
  slSport?: string;
  slYear?: string;
  slManufacturer?: string;
  bscSport?: string[];
  bscYear?: string[];
  bscSetName?: string[];
  /** Display name of the row's own set, for the BSC breadcrumb. */
  setLabel?: string;
  /** True when any node in the chain is user-created — skip marketplaces. */
  isCustom: boolean;
};

/**
 * Resolve the sport / year / manufacturer / setName context for an attach
 * dialog opened on `selectorOptionId`.
 *
 * Rejects rows the attach mutation itself would reject (`attachPlatformIds`
 * is variantType/insert/parallel only) so an unusable pool can never be built
 * for a row that could not receive it.
 */
async function resolveAttachContext(
  ctx: ActionCtx,
  selectorOptionId: Id<"selectorOptions">,
): Promise<AttachContext> {
  const chain = await ctx.runQuery(api.selectorOptions.getAncestorChain, {
    id: selectorOptionId,
  });
  const row = chain[chain.length - 1];
  if (!row) {
    throw new Error(`selectorOptions row not found: ${selectorOptionId}`);
  }
  if (
    row.level !== "variantType" &&
    row.level !== "insert" &&
    row.level !== "parallel"
  ) {
    throw new Error(
      `attach candidates are only defined for variantType/insert/parallel rows (got level=${row.level})`,
    );
  }

  const out: AttachContext = { isCustom: false };
  for (const ancestor of chain) {
    if (ancestor.isCustom === true) out.isCustom = true;
    const slIds = slotIds(ancestor, "sportlots");
    const bscIds = slotIds(ancestor, "bsc");
    switch (ancestor.level) {
      case "sport":
        out.sport = ancestor.value;
        out.slSport = slIds[0];
        out.bscSport = bscIds.length > 0 ? bscIds : undefined;
        break;
      case "year":
        out.year = ancestor.value;
        out.slYear = slIds[0];
        out.bscYear = bscIds.length > 0 ? bscIds : undefined;
        break;
      case "manufacturer":
        out.manufacturer = ancestor.value;
        out.slManufacturer = slIds[0];
        // manufacturer has no BSC facet — SL only (LEVEL_TO_BSC_FACET).
        break;
      case "setName":
        out.setName = ancestor.value;
        out.setLabel = ancestor.value;
        out.bscSetName = bscIds.length > 0 ? bscIds : undefined;
        break;
      default:
        break;
    }
  }
  return out;
}

const attachOptionValidator = v.object({
  value: v.string(),
  platformValue: v.string(),
});

/**
 * Every SportLots set under the row's sport / year / manufacturer.
 *
 * This is the SL side of NEO-196's "let me find a sibling set". SL's list is
 * already the full year+brand list — `fetchSetNames` ignores setName and
 * variantType entirely — so there is nothing to scope and no browse control on
 * this pane. What was broken was the LEVEL the dialog asked for: it passed the
 * NB row's own level, and SL answers "insert" only. A variantType row got
 * `{ success: true, options: [] }` (SL's documented unsupported-level reply)
 * and a parallel row got a hard `Unknown level: parallel` — in both cases the
 * dialog rendered an empty pane with no error.
 */
export const fetchSlAttachSets = action({
  args: { selectorOptionId: v.id("selectorOptions") },
  returns: v.object({
    success: v.boolean(),
    options: v.array(attachOptionValidator),
    message: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean;
    options: PlatformItem[];
    message: string;
  }> => {
    await requireAdmin(ctx);
    const cxt = await resolveAttachContext(ctx, args.selectorOptionId);
    if (cxt.isCustom) {
      return {
        success: true,
        options: [],
        message: "Custom subtree — no marketplace sets to attach",
      };
    }

    const platformFilters: Record<string, string> = {};
    if (cxt.slSport) platformFilters.sport = cxt.slSport;
    if (cxt.slYear) platformFilters.year = cxt.slYear;
    if (cxt.slManufacturer) platformFilters.manufacturer = cxt.slManufacturer;

    try {
      const result = await ctx.runAction(
        api.adapters.sportlots.fetchSportLotsSelectorOptions,
        {
          // SL's flat set list lives at NB level "insert" — see fetchSetNames.
          level: "insert",
          parentFilters: {
            ...(cxt.sport ? { sport: cxt.sport } : {}),
            ...(cxt.year ? { year: cxt.year } : {}),
            ...(cxt.manufacturer ? { manufacturer: cxt.manufacturer } : {}),
          },
          ...(Object.keys(platformFilters).length > 0
            ? { platformFilters }
            : {}),
        },
      );
      if (!result.success) {
        return {
          success: false,
          options: [],
          message: result.message || "SportLots fetch failed",
        };
      }
      return {
        success: true,
        options: result.options,
        message: `SL: ${result.options.length} set(s)`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[fetchSlAttachSets] SportLots error:`, error);
      return { success: false, options: [], message };
    }
  },
});

/**
 * The BSC side of NEO-196, in two views:
 *
 *   view "sets"     — every BSC set for the row's sport + year. BSC has no
 *                     manufacturer facet, so this spans manufacturers; the
 *                     pane says so and search narrows it.
 *   view "variants" — the variantName list for ONE BSC set: `setSlug` when the
 *                     operator has browsed to a sibling set, otherwise the
 *                     row's own set. This is the default view.
 *
 * Deliberately NOT filtered by the row's variantType. The dialog exists to
 * repair cross-marketplace mismatches, and BSC routinely files a set NB calls
 * a parallel under `variant=insert` (and vice versa); constraining the facet to
 * the NB row's own variant hid exactly the rows the operator came here for.
 * It also emptied the pane outright for Base rows, where BSC's variantName
 * facet under `variant=base` is usually empty (see BaseMappingForm).
 */
export const fetchBscAttachOptions = action({
  args: {
    selectorOptionId: v.id("selectorOptions"),
    view: v.union(v.literal("sets"), v.literal("variants")),
    // Only meaningful for view "variants". Omitted → the row's own set.
    setSlug: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    options: v.array(attachOptionValidator),
    // Echoed back so the breadcrumb can name the set the pane is showing even
    // on the default view, where the client never picked one.
    setSlug: v.optional(v.string()),
    message: v.string(),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean;
    options: PlatformItem[];
    setSlug?: string;
    message: string;
  }> => {
    await requireAdmin(ctx);
    const cxt = await resolveAttachContext(ctx, args.selectorOptionId);
    if (cxt.isCustom) {
      return {
        success: true,
        options: [],
        message: "Custom subtree — no marketplace sets to attach",
      };
    }

    const platformFilters: Record<string, string[]> = {};
    if (cxt.bscSport) platformFilters.sport = cxt.bscSport;
    if (cxt.bscYear) platformFilters.year = cxt.bscYear;

    // sport + year are what scope a BSC facet query. Without them the setName
    // aggregation is the whole catalogue, which is not a browsable pool — fail
    // loudly instead of handing the operator 40k rows.
    if (!platformFilters.sport || !platformFilters.year) {
      const missing = [
        platformFilters.sport ? null : "sport",
        platformFilters.year ? null : "year",
      ].filter(Boolean);
      return {
        success: false,
        options: [],
        message:
          `Missing platformData.bsc on: ${missing.join(", ")}. ` +
          `Upstream selectorOptions hydration did not write the BSC slugs ` +
          `needed to scope this query.`,
      };
    }

    // view "variants" needs a set to scope to; fall back to the row's own.
    const setSlug =
      args.view === "variants"
        ? (args.setSlug ?? cxt.bscSetName?.[0])
        : undefined;
    if (args.view === "variants" && !setSlug) {
      return {
        success: false,
        options: [],
        message:
          `Missing platformData.bsc on: setName=${cxt.setName ?? "(unknown)"}. ` +
          `Browse the year's sets to pick one explicitly.`,
      };
    }
    if (setSlug) platformFilters.setName = [setSlug];

    try {
      const result = await ctx.runAction(
        api.adapters.buysportscards.fetchBscSelectorOptions,
        {
          // "setName" → BSC's setName facet; "insert" → its variantName facet.
          level: args.view === "sets" ? "setName" : "insert",
          parentFilters: {
            ...(cxt.sport ? { sport: cxt.sport } : {}),
            ...(cxt.year ? { year: cxt.year } : {}),
          },
          platformFilters,
        },
      );
      if (!result.success) {
        return {
          success: false,
          options: [],
          ...(setSlug ? { setSlug } : {}),
          message: result.message || "BSC fetch failed",
        };
      }
      return {
        success: true,
        options: result.options,
        ...(setSlug ? { setSlug } : {}),
        message: `BSC: ${result.options.length} ${args.view === "sets" ? "set" : "variant"}(s)`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[fetchBscAttachOptions] BSC error:`, error);
      return { success: false, options: [], message };
    }
  },
});

// ===== MUTATIONS =====

// Normalize a WIRE platformData side to an array of marketplace IDs.
// The wire still speaks marketplace IDs — the client knows nothing about
// slots. Slots are assigned here, on the way into storage (NEO-137).
function wireToIds(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
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
        // NEO-137: marketplace-side display names, keyed by marketplace ID
        // (the wire format — the client has no slot keys). Stored against the
        // SLOT each ID lands in, which is what replaced
        // `platformData.sportlotsDisplay`: a single display string had no
        // meaning once one row could hold several SL sets.
        platformLabels: v.optional(v.object({
          bsc: v.optional(v.record(v.string(), v.string())),
          sportlots: v.optional(v.record(v.string(), v.string())),
        })),
        metadata: metadataValidator,
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

    // NEO-71-74: reconciledItems share one parentId — fetch its
    // already-complete `features` snapshot once and copy it onto every
    // fresh insert below (write-once feature snapshots: see
    // deriveOwnLevelFeatures in convex/features/deriveCardFeatures.ts).
    const parentFeatures: Record<string, string> | undefined = parentId
      ? (await ctx.db.get(parentId))?.features
      : undefined;

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
        // Refresh-without-clobber (NEO-6, reworked onto slots for NEO-137):
        // refresh only the PRIMARY SLOT's marketplace ID per side and keep
        // operator-attached extras untouched.
        //
        // The primary slot KEY is deliberately reused rather than retired.
        // The reconciler is re-identifying the same logical set — a marketplace
        // re-slug changes the ID, not which set it is — and every card already
        // pointing at that slot must keep resolving. Retiring the key here
        // would orphan the whole checklist on a routine re-sync.
        let working: {
          platformData: typeof existing.platformData;
          platformLabels: typeof existing.platformLabels;
          platformSlotSeq: typeof existing.platformSlotSeq;
        } = {
          platformData: existing.platformData,
          platformLabels: existing.platformLabels,
          platformSlotSeq: existing.platformSlotSeq,
        };
        const newPrimary: { bsc?: string; sportlots?: string } = {};

        for (const side of ["bsc", "sportlots"] as const) {
          const refreshedId = wireToIds(item.platformData[side])[0];
          const label = refreshedId
            ? item.platformLabels?.[side]?.[refreshedId]
            : undefined;
          const next = setPrimarySlotId(working, side, refreshedId, label);
          working = {
            platformData: next.platformData,
            platformLabels: next.platformLabels,
            platformSlotSeq: next.platformSlotSeq,
          };
          if (next.slot) newPrimary[side] = next.slot;
        }

        const prunedData = pruneEmptySides({ ...working.platformData });
        const prunedLabels = pruneEmptySides({ ...(working.platformLabels ?? {}) });

        const patch: Record<string, unknown> = {
          platformData: prunedData,
          lastUpdated: Date.now(),
        };
        patch.platformLabels =
          Object.keys(prunedLabels).length > 0 ? prunedLabels : undefined;
        patch.platformSlotSeq =
          working.platformSlotSeq &&
          Object.keys(working.platformSlotSeq).length > 0
            ? working.platformSlotSeq
            : undefined;
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
        await ctx.db.patch(existing._id, patch);
        insertedIds.push(existing._id);
      } else {
        // Fresh insert: reconciler is the only source of IDs, so the slots it
        // allocates are the primary on both sides.
        const bscIds = wireToIds(item.platformData.bsc);
        const slIds = wireToIds(item.platformData.sportlots);
        const alloc = initialSlots({
          bsc: bscIds.map((id) => ({
            id,
            ...(item.platformLabels?.bsc?.[id]
              ? { label: item.platformLabels.bsc[id] }
              : {}),
          })),
          sportlots: slIds.map((id) => ({
            id,
            ...(item.platformLabels?.sportlots?.[id]
              ? { label: item.platformLabels.sportlots[id] }
              : {}),
          })),
        });

        const newPrimary: { bsc?: string; sportlots?: string } = {};
        if (bscIds[0]) newPrimary.bsc = alloc.slotByIdBySide.bsc[bscIds[0]];
        if (slIds[0]) {
          newPrimary.sportlots = alloc.slotByIdBySide.sportlots[slIds[0]];
        }

        const features = {
          ...(parentFeatures ?? {}),
          ...deriveOwnLevelFeatures(level, item.value, item.metadata),
        };

        const hasLabels =
          Object.keys(alloc.platformLabels.bsc ?? {}).length > 0 ||
          Object.keys(alloc.platformLabels.sportlots ?? {}).length > 0;

        const id = await ctx.db.insert("selectorOptions", {
          level,
          value: item.value,
          platformData: alloc.platformData,
          ...(hasLabels ? { platformLabels: alloc.platformLabels } : {}),
          ...(Object.keys(newPrimary).length > 0
            ? { primaryPlatformId: newPrimary }
            : {}),
          ...(Object.keys(alloc.platformSlotSeq).length > 0
            ? { platformSlotSeq: alloc.platformSlotSeq }
            : {}),
          parentId,
          children: [],
          metadata: item.metadata,
          ...(Object.keys(features).length > 0 ? { features } : {}),
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
