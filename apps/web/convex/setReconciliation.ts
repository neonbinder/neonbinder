import { action, mutation } from "./_generated/server";
import type { ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { getCurrentUserId, requireAdmin } from "./auth";
import { deriveOwnLevelFeatures } from "./features/deriveCardFeatures";
import { platformServesLevel } from "./platformLevels";
import {
  slotIds,
  initialSlots,
  primaryId,
  pruneEmptySides,
  setPrimarySlotId,
} from "./platformSlots";
// NEO-211: the shared matcher / rename guard / unlink rule. The same module
// backs storeSelectorOptions, so the two stores cannot drift apart again.
import {
  PLATFORM_SIDES,
  checkSelectorValue,
  clearDeclinedIfLabelChanged,
  itemsReachPastSiblings,
  planSelectorSync,
  planValueRename,
  resolveReturnedIds,
  selectorValueKey,
  unlinkStalePrimary,
  valuesDeepEqual,
  type IncomingItem,
} from "./selectorSyncMatch";
import {
  MAX_SYNC_ITEMS,
  UNLINK_NOTICE_LIMIT,
  annotateHasCards,
  checkReturnedIds,
  heldElsewhereEntry,
  heldElsewhereEntryValidator,
  loadVariantTypeSubtreeElsewhere,
  withheldElsewhereEntry,
  withheldElsewhereEntryValidator,
  pausedSyncMessage,
  platformSideValidator,
  returnedIdsValidator,
  unionChildren,
  unaskedSidesNotice,
  unlinkedEntryValidator,
  type HeldElsewhereEntry,
  type UnlinkedEntry,
  type WithheldElsewhereEntry,
} from "./selectorSyncStore";
import {
  resolveBscFacetFilters,
  soleBscBaseVariantId,
  syncWrittenBscFacet,
} from "./bscFacets";
// NEO-291 — the insert/parallel flags are derived from where a row sits, not
// taken from the client. See convex/variantRole.ts.
import { derivedVariantFlags } from "./variantRole";
// NEO-291 — the one rule for a card number prefix, shared with
// `setSelectorOptionCardNumberPrefix` so the modal and the panel agree.
import { normalizeCardNumberPrefix } from "./cardNumberPrefix";
// NEO-277: the set-level team a fresh child inherits from its parent.
import { inheritedTeamIds } from "./lib/selectorTeams";
// NEO-239 — the per-side "can this marketplace be asked?" rule, shared with
// selectorOptions.ts so the reconciler and the aggregator cannot disagree.
import {
  BSC_NO_LINKED_SET_MESSAGE,
  NO_MARKETPLACE_IDS_MESSAGE,
  missingSummary,
  SL_ATTACH_REQUIRED_LEVELS,
  notifiableSkippedSides,
  pausedSideList,
  resolvableSides,
  skippedSideList,
  unscopedResolution,
  type ChainResolution,
  type ResolvableRow,
} from "./marketplaceResolvability";
// NEO-287 — the operator switch, read here and threaded into `resolvableSides`
// as an argument; the resolvability module itself never reads the environment.
import { pausedSides } from "./marketplacePause";
import type { Doc } from "./_generated/dataModel";

/**
 * A sentinel thrown to short-circuit a side's fetch block WITHOUT its catch
 * recording a `platformError`. A skipped side must never look like a failed
 * one: `coveredSides` is derived from errors, and a failure there is silence
 * that gets read as evidence.
 */
const SKIP_SIDE = Symbol("skip-side");

/**
 * NEO-239 — the ancestor chain a MUTATION needs to judge resolvability.
 *
 * `getAncestorChain` is an admin-gated query and a mutation cannot call it, so
 * `storeReconciledOptions` walks the parents itself. Mirrors the helper of the
 * same name in selectorOptions.ts; kept local per the no-cross-file-import
 * convention noted there for this pair of files.
 */
async function loadResolvabilityChain(
  ctx: { db: { get: (id: Id<"selectorOptions">) => Promise<Doc<"selectorOptions"> | null> } },
  leafId: Id<"selectorOptions"> | undefined,
): Promise<ResolvableRow[]> {
  const chain: ResolvableRow[] = [];
  let currentId: Id<"selectorOptions"> | undefined = leafId;
  while (currentId) {
    const row: Doc<"selectorOptions"> | null = await ctx.db.get(currentId);
    if (!row) break;
    chain.unshift({
      level: row.level,
      value: row.value,
      platformData: row.platformData ?? {},
      platformFacets: row.platformFacets,
    });
    currentId = row.parentId;
  }
  return chain;
}


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

/**
 * NEO-291 — the ONLY metadata the reconciliation modal may send: the card
 * number prefix. Deliberately NOT `selectorOptionFields.metadata` any more
 * (NEO-239 derived it from the table so a new field reached the wire for
 * free): the insert/parallel flags are now DERIVED from where a row sits
 * (convex/variantRole.ts) and `isBase` from BSC's base id, and a client-sent
 * value for any of them must be refused at the validator, not merged. A
 * bundle deployed before this ticket that still sends `isInsert` /
 * `isParallel` / `isBase` gets an argument-validation error rather than a
 * silent write, which is the right failure for a role a client no longer
 * owns.
 */
const metadataValidator = v.optional(
  v.object({ cardNumberPrefix: v.optional(v.string()) }),
);

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
    /**
     * NEO-239 (audit F1/R1) — sides this run NEVER ASKED for want of
     * marketplace ids on the chain. Distinct from `errors`: an error means the
     * side was asked and could not answer, a skip means it was never asked, and
     * only the second is silence that proves nothing. The client MUST subtract
     * these before it builds `coveredSides`, and `storeReconciledOptions`
     * subtracts them again server-side for bundles that predate this field.
     */
    skippedSides: v.array(platformSideValidator),
    /**
     * NEO-287 — the paused subset of `skippedSides`. The forms render the
     * paused sentence from it; coverage needs nothing extra because every
     * paused side is already in `skippedSides`.
     */
    pausedSides: v.array(platformSideValidator),
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
    skippedSides: Array<"bsc" | "sportlots">;
    pausedSides: Array<"bsc" | "sportlots">;
  }> => {
    await requireAdmin(ctx);
    // NEO-287 — read once per call. `pausedList` is derived from the chain's
    // resolution below (a side is paused only where the pause changed what
    // happens to it), hoisted so the failure return can carry it too.
    const paused = pausedSides();
    let pausedList: Array<"bsc" | "sportlots"> = [];
    try {
      const { level, parentId, parentFilters, baseSlPrefix } = args;

      console.log(
        `[fetchRawOptions] Fetching ${level} options with filters:`,
        parentFilters,
      );

      // NEO-216 — the same "serves this level" table the column sync reads
      // (convex/platformLevels.ts). A marketplace that does not model a level
      // is not fetched and NEVER lands in `platformErrors`, which is what this
      // action returns as `errors` — and `errors` is what the forms turn into
      // "<platform> failed, nothing was changed" and what
      // `coveredSidesFromErrors` reads. Reporting "not served" there produced a
      // failure alert on a healthy sync, exactly as it did in the Manufacturers
      // column.
      //
      // At `parallel` NEITHER side serves: BSC never had a facet for it (see
      // convex/bscFacets.ts) and SportLots has no sub-variant concept, so this
      // correctly fetches nothing and reports nothing rather than blaming both
      // marketplaces for a level neither has.
      const bscServesLevel = platformServesLevel("bsc", level);
      const slServesLevel = platformServesLevel("sportlots", level);

      // Build platform-specific filters from the ancestor chain
      let slPlatformFilters: Record<string, string> | undefined;
      let bscPlatformFilters: Record<string, string[]> | undefined;
      // NEO-237 — the manufacturer ancestor's `metadata.setNamePrefix`, for
      // the SportLots all-brands narrowing. Response filter only.
      let slBrandScope: { setNamePrefix: string } | undefined;
      // No parent = nothing to scope by and nothing that can be missing —
      // except a paused marketplace (NEO-287), which is never asked.
      let resolution: ChainResolution = unscopedResolution({ paused });

      if (parentId) {
        const chain = await ctx.runQuery(
          api.selectorOptions.getAncestorChain,
          { id: parentId },
        );

        // NEO-239 — PER-SIDE resolvability replaces BOTH the custom-subtree
        // skip and the BSC precondition that used to follow it.
        //
        // The two were doing the same job badly from opposite ends: the skip
        // covered "a human made a row on this path" and the precondition
        // covered "a synced row has no slug", and between them sat a
        // display-value fallback that turned a missing id into a wrong query
        // for every level not on the required list. Now a side is asked when
        // its ids are there and skipped when they are not, and no NB name ever
        // reaches a marketplace. NEO-287 — and a paused side is skipped
        // whatever the chain carries.
        resolution = resolvableSides(chain, { level, paused });

        slPlatformFilters = {};
        bscPlatformFilters = {};

        for (const ancestor of chain) {
          const lvl = ancestor.level;
          // NEO-137: adapters speak marketplace IDs, not slots. NEO-239: and
          // ONLY marketplace IDs — the `else if (ancestor.value)` fallback that
          // used to sit here is gone.
          const ancestorSlIds = slotIds(ancestor, "sportlots");
          if (ancestorSlIds.length > 0) {
            slPlatformFilters[lvl] = ancestorSlIds[0];
          }
          if (lvl === "manufacturer" && ancestor.metadata?.setNamePrefix) {
            slBrandScope = { setNamePrefix: ancestor.metadata.setNamePrefix };
          }
          const ancestorBscIds = slotIds(ancestor, "bsc");
          if (ancestorBscIds.length > 0) {
            bscPlatformFilters[lvl] = ancestorBscIds;
            // NEO-239 — no `else`. The display-value fallback that used to sit
            // here sent an NB name as a BSC filter, and the `precondMissingBsc`
            // branch beside it is now `resolvableSides` (which also carries
            // NEO-216's "only a precondition for a call we are going to MAKE"
            // refinement: an unserved level is unresolvable, not a failure).
          }
        }

        console.log(
          `[fetchRawOptions] Resolved platform filters — SL:`,
          slPlatformFilters,
          `BSC:`,
          bscPlatformFilters,
        );
      }

      const skippedSides = skippedSideList(resolution);
      pausedList = pausedSideList(resolution);
      if (skippedSides.length > 0) {
        console.log(
          `[fetchRawOptions] skipping ${skippedSides.join(",")} for ${level} — ` +
            `bsc_missing=${missingSummary(resolution.bsc)} ` +
            `sl_missing=${missingSummary(resolution.sportlots)}`,
        );
      }
      if (skippedSides.length === 2) {
        return {
          success: true,
          bscOptions: [],
          slOptions: [],
          autoMatched: [],
          unmatchedBsc: [],
          unmatchedSl: [],
          slCandidates: [],
          // NOT an error. The form routes empty-with-no-errors to onDone —
          // idle, "+ Custom" — which is exactly right for a level of NB's own
          // taxonomy that no marketplace stands behind.
          errors: [],
          // NEO-287 — unless a side is PAUSED: then the paused sentence leads
          // and the other side gets the no-ids sentence only if it models this
          // level. `NO_MARKETPLACE_IDS_MESSAGE` alone would misreport the pause
          // as a missing id.
          message:
            pausedList.length > 0
              ? (unaskedSidesNotice(
                  pausedList,
                  notifiableSkippedSides(resolution),
                ) ?? NO_MARKETPLACE_IDS_MESSAGE)
              : NO_MARKETPLACE_IDS_MESSAGE,
          skippedSides,
          pausedSides: pausedList,
        };
      }

      let bscOptions: PlatformItem[] = [];
      let slOptions: PlatformItem[] = [];
      const platformErrors: Record<string, string> = {};

      // Fetch from SportLots — only when the chain can scope it (NEO-239).
      try {
        if (!resolution.sportlots.resolvable) throw SKIP_SIDE;
        const result = await ctx.runAction(
          api.adapters.sportlots.fetchSportLotsSelectorOptions,
          {
            level,
            parentFilters: parentFilters || {},
            ...(slPlatformFilters ? { platformFilters: slPlatformFilters } : {}),
            // NEO-239 — label cleanup only; see the note on `labelContext`.
            ...(parentFilters?.manufacturer
              ? { labelContext: { manufacturer: parentFilters.manufacturer } }
              : {}),
            // NEO-237 — narrows the all-brands list to this brand's sets;
            // inert when the brand has its own SportLots id.
            ...(slBrandScope ? { brandScope: slBrandScope } : {}),
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
        // A SKIPPED side is not a FAILED side: it raises no `platformError`, so
        // it never enters `coveredSides` and nothing is unlinked on it.
        if (error !== SKIP_SIDE) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          platformErrors.sportlots = msg;
          console.error(`[fetchRawOptions] SportLots error:`, error);
        }
      }

      // Fetch from BSC — only when the chain can scope it (NEO-239).
      try {
        if (!resolution.bsc.resolvable) throw SKIP_SIDE;
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
        if (error !== SKIP_SIDE) {
          const msg = error instanceof Error ? error.message : "Unknown error";
          platformErrors.bsc = msg;
          console.error(`[fetchRawOptions] BSC error:`, error);
        }
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

      // Only sides that MODEL this level — see `notifiableSkippedSides`. A
      // structural skip is silent. NEO-287 — a paused side gets the paused
      // sentence instead; `unaskedSidesNotice` orders the two.
      const unaskedNotice = unaskedSidesNotice(
        pausedList,
        notifiableSkippedSides(resolution),
      );
      const skipSuffix = unaskedNotice ? ` ${unaskedNotice}` : "";

      return {
        success: true,
        bscOptions,
        slOptions,
        autoMatched,
        unmatchedBsc,
        unmatchedSl,
        slCandidates,
        errors,
        message: `BSC: ${bscOptions.length}, SL: ${slOptions.length}, Auto-matched: ${autoMatched.length}${warningSuffix}${skipSuffix}`,
        skippedSides,
        pausedSides: pausedList,
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
        skippedSides: [] as Array<"bsc" | "sportlots">,
        pausedSides: pausedList,
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
  /**
   * NEO-237 — the manufacturer ancestor's `metadata.setNamePrefix`. Passed to
   * the SportLots adapter as `brandScope`, which narrows the all-brands list
   * to this brand's sets and leaves a real brand's own list alone.
   */
  slSetNamePrefix?: string;
  bscSport?: string[];
  bscYear?: string[];
  /**
   * NEO-252 — the BSC set(s) this path names, from `resolveBscFacetFilters`,
   * so a set attached at the LEAF counts exactly as one attached at the
   * setName ancestor does.
   */
  bscSetName?: string[];
  /** Display name of the row's own set, for the BSC breadcrumb. */
  setLabel?: string;
  /**
   * NEO-239 — which side this row's chain can actually be asked, replacing
   * `isCustom`. The SL side uses the ATTACH rule (`SL_ATTACH_REQUIRED_LEVELS`),
   * which adds `manufacturer`: SportLots' set list is scoped by `brd`, and an
   * empty `brd` is not a narrower pool but every brand in the year.
   */
  resolution: ChainResolution;
  /**
   * NEO-287 — the raw operator switch, for the BSC pane whose gate is NOT
   * `resolution.bsc.resolvable` (it browses the YEAR's sets, so it needs only
   * sport + year ids; see `fetchBscAttachOptions`). The pane applies the pause
   * after its own scope gate, so a path with no BSC ids stays a plain skip.
   */
  paused: ReadonlySet<"bsc" | "sportlots">;
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

  // NEO-287 — a paused marketplace has no pool to browse this run; the pane
  // says so instead of listing candidates. Read once, threaded into the SL
  // side's resolution here and applied by the BSC pane after its own gate.
  const paused = pausedSides();
  const out: AttachContext = {
    resolution: resolvableSides(chain, {
      slRequired: SL_ATTACH_REQUIRED_LEVELS,
      paused,
    }),
    paused,
  };
  for (const ancestor of chain) {
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
        out.slSetNamePrefix = ancestor.metadata?.setNamePrefix;
        // manufacturer has no BSC facet — SL only (LEVEL_TO_BSC_FACET).
        break;
      case "setName":
        out.setName = ancestor.value;
        out.setLabel = ancestor.value;
        // `bscSetName` is NOT read here — see the facet plan below.
        break;
      default:
        break;
    }
  }

  // NEO-252 — which BSC SET this path names, taken from the facet plan the
  // checklist fetch would build rather than from the setName ancestor's own
  // slots.
  //
  // Same fact, wider aperture, and the difference is a real shape: NEO-189 lets
  // an NB row draw from BSC sets attached at the LEAF (Base ← Series 1 +
  // Series 2), and it is also how a set NeonBinder built first gets its first
  // BSC link — the operator attaches the BSC set on the variant row, because
  // that is where this dialog lives. Reading only the ancestor called all of
  // those "no BSC set" and sent the operator an error naming their own set.
  //
  // `setLabel` deliberately still comes from the ancestor above: it is the
  // breadcrumb's NB display text, not a marketplace id, and the leaf's label
  // would name a variant rather than the set the pane is scoped to.
  const planSetName = resolveBscFacetFilters(chain).filters.setName;
  if (planSetName && planSetName.length > 0) out.bscSetName = planSetName;

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
    /**
     * NEO-287 — `["sportlots"]` when the operator paused SportLots, so the pane
     * can render the paused state structurally rather than by matching
     * `message`. `[]` otherwise.
     */
    pausedSides: v.array(platformSideValidator),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean;
    options: PlatformItem[];
    message: string;
    pausedSides: Array<"bsc" | "sportlots">;
  }> => {
    await requireAdmin(ctx);
    const cxt = await resolveAttachContext(ctx, args.selectorOptionId);
    // NEO-287 — paused beats unscoped: nothing is asked and the pane says why.
    // A SKIP with a fixed sentence, exactly like the no-ids branch below.
    if (cxt.resolution.sportlots.paused) {
      console.log(`[fetchSlAttachSets] SportLots is paused — not asked`);
      return {
        success: true,
        options: [],
        message: pausedSyncMessage(["sportlots"]),
        pausedSides: ["sportlots"],
      };
    }
    // NEO-239 — the precondition this action never had. `fetchBscAttachOptions`
    // below has always refused an unscoped BSC pool ("40k rows is not a
    // browsable pool"); the SL side sent `sprt`/`yr`/`brd` as whatever it had,
    // and an empty `brd` returns every brand in the year — a WIDER pool than
    // the operator asked for, delivered with no error.
    if (!cxt.resolution.sportlots.resolvable) {
      console.log(
        `[fetchSlAttachSets] no SportLots ids on this path — ` +
          `missing=${missingSummary(cxt.resolution.sportlots)}`,
      );
      return {
        success: true,
        options: [],
        message: NO_MARKETPLACE_IDS_MESSAGE,
        pausedSides: [],
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
          // NEO-239 — label cleanup only; see the note on `labelContext`. The
          // attach pane lists candidate sets by name, so the same duplication
          // ("Topps Topps Series 1" against the brand heading) applies here.
          ...(cxt.manufacturer
            ? { labelContext: { manufacturer: cxt.manufacturer } }
            : {}),
          // NEO-237 — a brand linked through All Brands browses only the
          // sets that start with its prefix; a real brand is unaffected.
          ...(cxt.slSetNamePrefix
            ? { brandScope: { setNamePrefix: cxt.slSetNamePrefix } }
            : {}),
        },
      );
      if (!result.success) {
        return {
          success: false,
          options: [],
          message: result.message || "SportLots fetch failed",
          pausedSides: [],
        };
      }
      return {
        success: true,
        options: result.options,
        message: `SL: ${result.options.length} set(s)`,
        pausedSides: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[fetchSlAttachSets] SportLots error:`, error);
      return { success: false, options: [], message, pausedSides: [] };
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
    /** NEO-287 — `["bsc"]` when the operator paused BuySportsCards; see `fetchSlAttachSets`. */
    pausedSides: v.array(platformSideValidator),
  }),
  handler: async (
    ctx,
    args,
  ): Promise<{
    success: boolean;
    options: PlatformItem[];
    setSlug?: string;
    message: string;
    pausedSides: Array<"bsc" | "sportlots">;
  }> => {
    await requireAdmin(ctx);
    const cxt = await resolveAttachContext(ctx, args.selectorOptionId);

    const platformFilters: Record<string, string[]> = {};
    if (cxt.bscSport) platformFilters.sport = cxt.bscSport;
    if (cxt.bscYear) platformFilters.year = cxt.bscYear;

    // sport + year are what scope a BSC facet query. Without them the setName
    // aggregation is the whole catalogue, which is not a browsable pool.
    //
    // NEO-239 — this is `resolvableSides` asked of the BSC side, and it now
    // covers the case the `isCustom` gate above it used to catch. A skip, not a
    // failure: a row whose chain carries no BSC ids has nothing to browse, and
    // the operator can still attach on the SportLots pane.
    //
    // The `setName` requirement is deliberately NOT applied here — this pane
    // exists to browse the YEAR's sets and find a sibling, so the row's own set
    // slug is optional (see the `view: "variants"` fallback below).
    if (!platformFilters.sport || !platformFilters.year) {
      console.log(
        `[fetchBscAttachOptions] no BSC ids to scope the pool — ` +
          `missing=${missingSummary(cxt.resolution.bsc)}`,
      );
      return {
        success: true,
        options: [],
        message: NO_MARKETPLACE_IDS_MESSAGE,
        pausedSides: [],
      };
    }

    // NEO-287 — the pause is applied AFTER the scope gate above and BEFORE
    // the no-linked-set hop below: a path with no BSC ids is a plain skip the
    // pause never touches (invariant 6), while a scoped path — whichever view,
    // since the "variants" hop lands on the set list, which WOULD be asked —
    // is a pool the pause kept us from browsing, and the pane says so.
    if (cxt.paused.has("bsc")) {
      console.log(`[fetchBscAttachOptions] BuySportsCards is paused — not asked`);
      return {
        success: true,
        options: [],
        message: pausedSyncMessage(["bsc"]),
        pausedSides: ["bsc"],
      };
    }

    // view "variants" needs a set to scope to; fall back to the row's own.
    const setSlug =
      args.view === "variants"
        ? (args.setSlug ?? cxt.bscSetName?.[0])
        : undefined;
    if (args.view === "variants" && !setSlug) {
      // NEO-252 — a SKIP with a fixed sentence, not a failure with an NB value
      // in it. Nothing is wrong here: the path simply names no BSC set to list
      // the variants of, which is the ordinary state of a set NeonBinder built
      // before linking it. The dialog reads this by equality and hops to the
      // set list, which is the pane that fixes it.
      console.log(
        `[fetchBscAttachOptions] no BSC set on this path — ` +
          `missing=${missingSummary(cxt.resolution.bsc)}`,
      );
      return {
        success: true,
        options: [],
        message: BSC_NO_LINKED_SET_MESSAGE,
        pausedSides: [],
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
          pausedSides: [],
        };
      }
      return {
        success: true,
        options: result.options,
        ...(setSlug ? { setSlug } : {}),
        message: `BSC: ${result.options.length} ${args.view === "sets" ? "set" : "variant"}(s)`,
        pausedSides: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[fetchBscAttachOptions] BSC error:`, error);
      return { success: false, options: [], message, pausedSides: [] };
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

/**
 * NEO-296 — how many WRITES one `storeReconciledOptions` transaction may make
 * before it stops storing items and reports the rest back to its caller.
 *
 * ## The failure this exists to stop
 *
 * Convex counts one system operation per CALL — a `db.get`, an indexed read
 * (`.first()` / `.unique()` / `.collect()` / `.take()`), an `insert`, a
 * `patch`, a `scheduler.runAfter`. A `.collect()` that returns 754 rows is ONE
 * of those; the document count belongs to a separate budget with its own
 * error. So what kills a transaction here is never the size of the sibling
 * snapshot — it is the loop.
 *
 * `MAX_SYNC_ITEMS` (2,000, `selectorSyncStore.ts`) was sized as "generous
 * headroom" for the matcher's CPU cost, with no reference to what an item
 * costs in operations. Counted, one call spends:
 *
 *   1   — the parent `db.get` for the features / teamIds copy-down
 *   1   — the sibling `.collect()` (one op, whatever it returns)
 *   ≤7  — `loadResolvabilityChain`, one `db.get` per ancestor level
 *   1   — per item that lands as a fresh INSERT
 *   1   — per item that lands on an existing row AND changes it (one `patch`
 *         in the write pass, however many passes touched that row)
 *   1   — per sibling the UNLINK pass detaches a stale primary id from
 *   2   — the parent `db.get` + `patch` for the `children` union
 *   ≤50 — `annotateHasCards`, one indexed read per unlink notice
 *         (`UNLINK_NOTICE_LIMIT`)
 *
 * At the 2,000-item cap over a 1,000-row sibling list that is 2,000 inserts +
 * up to 1,000 patches + ~60 fixed ≈ 3,050 operations; 2,000 fresh items over
 * 2,000 stale siblings reaches ~4,060. The house calibration — see
 * `CARDS_PER_COMMIT_CHUNK` in selectorOptions.ts, sized off this same Convex
 * error in NEO-189 — is **~900 comfortable, ~1,800 straining, ~4,000 failing
 * outright**. The cap sat past the failing line.
 *
 * Latent rather than live today: the callers are `VariantForm` and
 * `ParallelForm` at ~100–200 rows, which spend 300–600. But it is exactly the
 * shape this function's own `checkReturnedIds` note records — SportLots listed
 * 2,563 sets for one year, the form passed them all, and "Save 76 sets" never
 * completed — so it is bounded now rather than the next time a big year
 * arrives.
 *
 * ## Why a WRITE budget rather than a smaller item cap
 *
 * An item that matches a row and changes nothing costs ZERO operations
 * (NEO-85's write-if-changed guard), and on a re-run every item the previous
 * call stored is exactly that. Counting WRITES rather than items is therefore
 * what makes the truncation **resumable by replay**: the caller re-sends the
 * identical list, the stored prefix re-matches by id for free, and the call
 * walks on into the tail. An item cap would have made the second call re-spend
 * its whole budget on the prefix and never advance. Nothing is applied twice
 * either way — the store is additive and id-keyed, and each page commits as its
 * own transaction.
 *
 * 800 writes plus the ~60 fixed operations above lands just under the ~900
 * comfortable line.
 *
 * The UNLINK pass is counted in the same budget but is never truncated. It is
 * evidence-driven (a covered side, plus a primary id the fetch did not return),
 * it is the pass the whole `returnedIds` machinery exists to keep small, and
 * dropping a detachment silently is the one thing invariant 5 forbids. Its cost
 * lands in the returned `writeOps`, so a run that does go past the budget says
 * so in its own result rather than only in a Convex error.
 *
 * Exported so a test can build a deliberately multi-page batch without
 * hard-coding the number.
 */
export const RECONCILE_STORE_WRITE_BUDGET = 800;

/**
 * NEO-211 — additive, id-keyed store for the reconciled levels.
 *
 * Same rewrite as `storeSelectorOptions`, plus the two things only the
 * reconciler has: per-id marketplace LABELS (what BSC/SL call the set, which
 * is what `getSelectorSyncSuggestions` later reads), and `existingId` — the
 * reconciliation modal knows which NB row a title belongs to, so a title
 * edited in the modal becomes a RENAME of that row instead of the delete +
 * empty re-insert it used to be.
 *
 * The delete pass is gone. A row upstream stops listing keeps its `_id`, its
 * name, its children and its cards; only the marketplace pointer is removed,
 * and only on a side the caller says it actually fetched.
 */
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
        /**
         * NEO-211 E — the NB row this modal line is about, when the modal
         * knows. Tier 0 of the matcher. Resolved ONLY against the sibling
         * snapshot at this (level, parentId): a client cannot use it to reach
         * a row somewhere else in the tree, and a miss falls through to the
         * id/name tiers rather than failing.
         */
        existingId: v.optional(v.id("selectorOptions")),
      }),
    ),
    /**
     * Sides fetched SUCCESSFULLY. Absent = unlink nothing — an old SPA bundle
     * mid-deploy has no way to say "SportLots was down", so silence has to
     * mean silence rather than "infer it from what came back".
     */
    coveredSides: v.optional(v.array(platformSideValidator)),
    /**
     * NEO-211 F1 — the ids the FETCH returned, per side.
     *
     * On this path it is NOT `reconciledItems`. `ReconciliationModal` seeds
     * every existing row into Ready, so the items are the OPERATOR's confirmed
     * set: a genuinely delisted row is still among them (so it would never be
     * unlinked), and a row the operator DISBANDED is absent from them (so it
     * would be unlinked and reported back to that operator as "no longer
     * listed on BSC", which is false). Pass the fetch's own id list.
     */
    returnedIds: v.optional(returnedIdsValidator),
  },
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    optionsCount: v.number(),
    unlinked: v.array(unlinkedEntryValidator),
    unlinkedTotal: v.number(),
    /** Rows rebound to a new id for the same set (a marketplace re-slug). */
    relinked: v.array(unlinkedEntryValidator),
    relinkedTotal: v.number(),
     /**
     * Sides whose `returnedIds` list was over the cap and so were treated as
     * NOT covered this run: everything was still stored additively, but
     * nothing was unlinked on them. Empty on every normal sync.
     */
    returnedIdsTruncatedSides: v.array(platformSideValidator),
    /**
     * NEO-296 — items this call actually reached, in the order they were sent.
     * Less than `reconciledItems.length` means the write budget stopped the
     * loop; the rows behind it were neither stored nor unlinked, and nothing
     * about them was decided.
     */
    itemsProcessed: v.number(),
    /**
     * NEO-296 — this call stopped on `RECONCILE_STORE_WRITE_BUDGET` rather
     * than on the end of the list. Call again with the SAME list: the prefix
     * this call stored re-matches by id, costs no write, and the walk
     * continues into the tail. Never true on a batch that fits, which is every
     * batch the forms send today.
     *
     * A CALLER MUST READ THIS. Both clients do it through
     * `components/SetSelector/store-reconciled-until-done.ts`, which replays
     * until it is false and reports the server's own `message` if a bound
     * stops the walk. Ignoring it — which is what `VariantForm` and
     * `ParallelForm` did when the budget landed — drops every row past the
     * budget and closes the panel on a success the operator can act on but
     * that did not happen.
     */
    hasMore: v.boolean(),
    /**
     * NEO-296 — inserts plus patches this transaction made, for the log and
     * for a caller that wants to size its own batches. See
     * `RECONCILE_STORE_WRITE_BUDGET` for what one operation is.
     */
    writeOps: v.number(),
    /**
     * NEO-300 — items that name a row already living ELSEWHERE in this
     * variant type's subtree (an insert the operator grouped under another
     * insert as a parallel, or a parallel they moved up to an insert). The
     * store left each one exactly where the operator put it: no new row, no
     * move, no rename, no platform write. One entry per held ROW, NB names
     * only, capped at `UNLINK_NOTICE_LIMIT`; `heldElsewhereTotal` is the true
     * count. Recomputed over the items this call reached, so a replay's LAST
     * page carries the whole answer (like `optionsCount`).
     */
    heldElsewhere: v.array(heldElsewhereEntryValidator),
    heldElsewhereTotal: v.number(),
    /**
     * NEO-300 (security audit) — items WITHHELD because of what the subtree
     * holds: their ids are on several rows elsewhere (`heldByMany`), or the
     * modal's `existingId` names a subtree row that does not hold the item's
     * id (`idsDisagree`). Nothing was written for them; the operator is told
     * rather than only the log. Capped at `UNLINK_NOTICE_LIMIT`; the true
     * count is `withheldElsewhereTotal`. Recomputed per page — last page wins.
     */
    withheldElsewhere: v.array(withheldElsewhereEntryValidator),
    withheldElsewhereTotal: v.number(),
    /**
     * NEO-300 (security audit) — the subtree walk was needed but a bound
     * (`MAX_SUBTREE_WALK_INSERTS` / `MAX_SUBTREE_WALK_DOCUMENTS`) stopped it,
     * so this call matched against siblings only and a grouped row may have
     * been re-created. False on every real set. Last page wins.
     */
    subtreeWalkSkipped: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const { level, parentId, reconciledItems } = args;

    if (reconciledItems.length > MAX_SYNC_ITEMS) {
      throw new Error(
        `storeReconciledOptions: ${reconciledItems.length} items exceeds the ` +
          `${MAX_SYNC_ITEMS}-per-call limit`,
      );
    }

    // NEO-71-74: reconciledItems share one parentId — fetch its
    // already-complete `features` snapshot once and copy it onto every
    // fresh insert below (write-once feature snapshots: see
    // deriveOwnLevelFeatures in convex/features/deriveCardFeatures.ts).
    const parentRowForCopyDown = parentId ? await ctx.db.get(parentId) : null;
    const parentFeatures: Record<string, string> | undefined =
      parentRowForCopyDown?.features;
    // NEO-277: the parent's set-level team, copied onto every fresh insert
    // below exactly as `features` is — once, at creation, never onto a row the
    // reconciler merely re-links (see schema.ts `teamIds`).
    const parentTeamIds = inheritedTeamIds(parentRowForCopyDown);

    const existingOptions = await ctx.db
      .query("selectorOptions")
      .withIndex("by_level_and_parent", (q) =>
        q.eq("level", level).eq("parentId", parentId),
      )
      .collect();

    const items: IncomingItem[] = reconciledItems.map((item) => {
      const bsc = wireToIds(item.platformData.bsc)[0];
      const sportlots = wireToIds(item.platformData.sportlots)[0];
      return {
        value: item.value,
        ids: {
          ...(bsc ? { bsc } : {}),
          ...(sportlots ? { sportlots } : {}),
        },
        ...(item.existingId ? { existingId: item.existingId } : {}),
      };
    });

    // NEO-211 — a `returnedIds` side over the cap DEGRADES, it does not throw.
    // The old throw took down a real sync: SportLots lists 2,563 sets for one
    // year, the form passed them all, and "Save 76 sets" never completed. The
    // bound only ever guarded the UNLINK pass, so an oversized list costs an
    // unlink notice for this run — not the operator's saved work. The side
    // falls back to the items for staleness (the pre-`returnedIds` behaviour)
    // and is dropped from coverage, so nothing is unlinked on it.
    const { truncatedSides } = checkReturnedIds(args.returnedIds, "storeReconciledOptions");
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
    // NEO-239 (audit F1/R1) — NARROW COVERAGE SERVER-SIDE.
    //
    // `coveredSides` is built by the client from ERRORS, and a side skipped for
    // want of marketplace ids raises none. Left alone it would arrive marked
    // covered with an empty `returnedIds`, and the unlink pass below would read
    // that as "upstream dropped every set" and detach the primary slot of every
    // sibling row on a side nobody queried. `fetchRawOptions` subtracts its own
    // `skippedSides`, but an SPA bundle from before this ticket does not know
    // the field exists, so the mutation re-derives the answer from the parent
    // chain it can read itself.
    const parentChain = await loadResolvabilityChain(ctx, parentId);
    // NO `level` here, deliberately, and it is a different question from the
    // fetch's. The fetch asks "can this side ANSWER at this level?" — which
    // includes whether it serves the level at all. The store is not fetching:
    // its only job (audit F1/R1) is to refuse coverage for a side the chain
    // carries no ids for, so a caller cannot license the unlink pass on a
    // marketplace that was never reachable. Applying the served-level table
    // here would ALSO block a legitimate unlink the caller declared with
    // evidence — a reconciled variantType batch that says "SportLots answered,
    // and this row's id was not in it".
    //
    // NEO-287 — the pause is threaded in here too: a paused side was not asked
    // this run, so a caller that still declares it covered is refused the same
    // way. Nothing is unlinked on a marketplace nobody queried.
    const chainResolution = resolvableSides(parentChain, { paused: pausedSides() });
    const effectiveCovered = (args.coveredSides ?? [])
      .filter((side) => !truncatedSides.includes(side))
      .filter((side) => {
        if (chainResolution[side].resolvable) return true;
        console.warn(
          `[storeReconciledOptions] dropping ${side} from coveredSides — ` +
            (chainResolution[side].paused
              ? `${side} is paused`
              : `the parent chain carries no ${side} ids`) +
            ` — missing=${missingSummary(chainResolution[side])}. Nothing will ` +
            `be unlinked on that side.`,
        );
        return false;
      });

    // NEO-300 — the rest of the variant type's subtree, so a row an operator
    // grouped (insert ↔ parallel) is recognised by its ids instead of being
    // re-created at its old level. Read only when some item names an id or
    // an `existingId` no sibling holds; a re-sync that stays inside the
    // siblings pays nothing. See `loadVariantTypeSubtreeElsewhere`.
    const subtree = itemsReachPastSiblings(existingOptions, items)
      ? await loadVariantTypeSubtreeElsewhere(ctx, {
          level,
          parent: parentRowForCopyDown,
          siblings: existingOptions,
        })
      : null;

    const plan = planSelectorSync({
      existing: existingOptions,
      items,
      coveredSides: effectiveCovered,
      returnedIds: effectiveReturnedIds,
      ...(subtree ? { elsewhereInSubtree: subtree.rows } : {}),
    });
    if (plan.ambiguities.length > 0) {
      console.warn(
        `[storeReconciledOptions] withheld ${plan.ambiguities.length} item(s) ` +
          `at level=${level}: ` +
          JSON.stringify(plan.ambiguities.slice(0, 10)),
      );
    }

    type ExistingRow = (typeof existingOptions)[number];
    type Working = {
      row: ExistingRow;
      value: string;
      features?: Record<string, string>;
      sportConfig?: ExistingRow["sportConfig"];
      platformData: ExistingRow["platformData"];
      platformLabels: ExistingRow["platformLabels"];
      platformFacets: ExistingRow["platformFacets"];
      platformSlotSeq: ExistingRow["platformSlotSeq"];
      primaryPlatformId: ExistingRow["primaryPlatformId"];
      declinedUpstreamLabels: ExistingRow["declinedUpstreamLabels"];
      metadata: ExistingRow["metadata"];
    };
    const byRowId = new Map<string, ExistingRow>();
    for (const row of existingOptions) byRowId.set(row._id, row);
    const working = new Map<string, Working>();
    const workingFor = (row: ExistingRow): Working => {
      let w = working.get(row._id);
      if (!w) {
        w = {
          row,
          value: row.value,
          features: row.features,
          platformData: row.platformData,
          platformLabels: row.platformLabels,
          platformFacets: row.platformFacets,
          platformSlotSeq: row.platformSlotSeq,
          primaryPlatformId: row.primaryPlatformId,
          declinedUpstreamLabels: row.declinedUpstreamLabels,
          metadata: row.metadata,
        };
        working.set(row._id, w);
      }
      return w;
    };
    /** The clash check's view of sibling names, moving as renames land. */
    const workingSiblings = () =>
      existingOptions.map((r) => ({
        _id: r._id as string,
        value: working.get(r._id)?.value ?? r.value,
      }));

    /**
     * The patch a working row would receive, or `{}` for a row nothing
     * changed on — NEO-85's write-if-changed guard, lifted out of the write
     * pass below.
     *
     * Pure: it reads and writes no database. NEO-296 needs the answer TWICE —
     * once in the item loop, to charge the write budget only for items that
     * actually cost an operation (a matched item that changes nothing is free,
     * and that is what makes a truncated call resumable by replay), and once in
     * the write pass that performs it. Two copies of these eight comparisons
     * would be two chances for the budget to charge for a write that never
     * happens, or to let one through uncounted.
     */
    const pendingPatchFor = (w: Working): Record<string, unknown> => {
      const prunedData = pruneEmptySides({ ...w.platformData });
      const prunedLabels = pruneEmptySides({ ...(w.platformLabels ?? {}) });
      const prunedFacets = pruneEmptySides({ ...(w.platformFacets ?? {}) });
      const nextLabels =
        Object.keys(prunedLabels).length > 0 ? prunedLabels : undefined;
      const nextFacets =
        Object.keys(prunedFacets).length > 0 ? prunedFacets : undefined;
      const nextSlotSeq =
        w.platformSlotSeq && Object.keys(w.platformSlotSeq).length > 0
          ? w.platformSlotSeq
          : undefined;

      const patch: Record<string, unknown> = {};
      if (w.value !== w.row.value) {
        patch.value = w.value;
        if (w.features) patch.features = w.features;
        if (w.sportConfig) patch.sportConfig = w.sportConfig;
      }
      if (!valuesDeepEqual(prunedData, w.row.platformData)) {
        patch.platformData = prunedData;
      }
      if (!valuesDeepEqual(nextLabels ?? null, w.row.platformLabels ?? null)) {
        patch.platformLabels = nextLabels;
      }
      if (!valuesDeepEqual(nextFacets ?? null, w.row.platformFacets ?? null)) {
        patch.platformFacets = nextFacets;
      }
      if (!valuesDeepEqual(nextSlotSeq ?? null, w.row.platformSlotSeq ?? null)) {
        patch.platformSlotSeq = nextSlotSeq;
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
      if (!valuesDeepEqual(w.metadata ?? null, w.row.metadata ?? null)) {
        patch.metadata = w.metadata;
      }
      return patch;
    };

    // NEO-239 — the base ROLE, decided once for the whole batch. Same rule as
    // `storeSelectorOptions`: exactly one incoming BSC id may name the base
    // variant, and a set whose base an operator has already chosen is left
    // alone. See `isBscBaseVariantId` for why it is a token match on the
    // marketplace id rather than a literal or the NB display value.
    const baseVariantId =
      level === "variantType"
        ? soleBscBaseVariantId(items.map((item) => item.ids.bsc))
        : undefined;
    const siblingHoldsBaseRole = existingOptions.some(
      (row) => row.metadata?.isBase === true,
    );
    const confersBaseRole = (ids: Partial<Record<"bsc" | "sportlots", string>>) =>
      baseVariantId !== undefined &&
      !siblingHoldsBaseRole &&
      ids.bsc === baseVariantId;

    // NEO-291 — the flags every insert/parallel-level row in this batch is
    // born with, from its level and the parent's role (the parent's tagged
    // BSC slot, never its name). One parent per call, so one answer.
    const variantFlags = derivedVariantFlags(level, parentRowForCopyDown);

    const linkedIds: Id<"selectorOptions">[] = [];
    const relinkedAll: UnlinkedEntry[] = [];

    /**
     * NEO-296 — the write budget, counted rather than estimated.
     *
     * `inserts` are spent the moment they happen; `willPatch` holds the rows
     * the loop has made dirty, each of which costs exactly one `patch` in the
     * write pass no matter how many items or passes touched it. Their sum is
     * what the budget bounds. A matched item that changes nothing adds to
     * neither, which is why re-sending the same list finishes the job.
     */
    let inserts = 0;
    const willPatch = new Set<string>();
    /** Items this call reached. The rest are the caller's next call. */
    let itemsProcessed = 0;
    // NEO-300 — the subtree walk is one read per insert, counted at the call
    // site, and charged against this call's budget so the transaction's total
    // stays where `RECONCILE_STORE_WRITE_BUDGET` put it. Capped at half the
    // budget so a call always has room to advance, which keeps the replay
    // finishing (the walk costs the same on every page). Half is ~400 inserts
    // under one variant type — past any real set.
    const writeBudget =
      RECONCILE_STORE_WRITE_BUDGET -
      Math.min(subtree?.reads ?? 0, RECONCILE_STORE_WRITE_BUDGET / 2);
    const subtreeRowsById = new Map<string, Doc<"selectorOptions">>(
      (subtree?.rows ?? []).map((row) => [row._id, row]),
    );
    const heldElsewhereById = new Map<string, HeldElsewhereEntry>();
    const withheldElsewhereAll: WithheldElsewhereEntry[] = [];

    for (let i = 0; i < reconciledItems.length; i++) {
      // The bound is checked BEFORE the item, so the last item admitted is the
      // one that spent the budget rather than the one after it. Everything
      // already decided is written by the passes below and commits with this
      // transaction; the tail is untouched, not half-applied.
      if (inserts + willPatch.size >= writeBudget) break;
      itemsProcessed = i + 1;
      const item = reconciledItems[i];
      const parsed = items[i];
      const outcome = plan.outcomes[i];
      if (outcome.kind === "withheld") {
        // NEO-300 — a subtree withhold reaches the operator, not only the
        // log. Sibling-level withholds are unchanged (log-only).
        if (outcome.elsewhere) {
          withheldElsewhereAll.push(
            withheldElsewhereEntry(
              item.value,
              outcome.elsewhere,
              subtreeRowsById,
              subtree?.parentsById ?? new Map(),
            ),
          );
        }
        continue;
      }

      // NEO-300 — the row is already in this variant type's subtree, where the
      // operator put it. Nothing is written to it or for it: not an insert,
      // not a reparent, not a level change, not a rename — and not the
      // platform refresh a sibling match gets either. The id that identified
      // it is already in its slot; the only things a refresh could change are
      // a label or the OTHER side's id, and writing those from a fetch scoped
      // to a different level onto a row this call does not own is a silent
      // relink (invariants 3 and 5). Reported instead.
      if (outcome.kind === "heldElsewhere") {
        const row = subtreeRowsById.get(outcome.rowId);
        const entry =
          row && subtree ? heldElsewhereEntry(row, subtree.parentsById) : null;
        if (entry) heldElsewhereById.set(entry.id, entry);
        continue;
      }

      if (outcome.kind === "matched") {
        const row = byRowId.get(outcome.existingId)!;
        const w = workingFor(row);

        // NEO-211 E — a title edited inside the reconciliation modal renames
        // the row it belongs to. ONLY on a tier-0 match: an id- or name-match
        // is the sync recognising a row, not an operator asking for a new
        // name, and the sync has never been allowed to write `value`.
        if (
          outcome.tier === 0 &&
          selectorValueKey(item.value) !== selectorValueKey(w.value)
        ) {
          const renamePlan = planValueRename({
            row: {
              _id: row._id,
              level: row.level,
              value: w.value,
              features: w.features,
              sportConfig: row.sportConfig,
              // NEO-294 — this modal runs at every level, manufacturer
              // included, so a tier-0 title edit is a fourth door onto the
              // year's Unknown row. Hand over the role flags and the shared
              // planner refuses it here too; the `!renamePlan.ok` branch
              // below already logs and keeps the linkage.
              metadata: row.metadata,
            },
            nextValue: item.value,
            siblings: workingSiblings(),
          });
          if (renamePlan.ok && !renamePlan.unchanged) {
            w.value = renamePlan.value;
            if (renamePlan.features) w.features = renamePlan.features;
            if (renamePlan.sportConfig) w.sportConfig = renamePlan.sportConfig;
          } else if (!renamePlan.ok) {
            // Clashing or invalid. (The "protected variantType" refusal is gone
            // as of NEO-239.) The LINKAGE below still applies — refusing a name
            // is not a reason to drop the marketplace mapping the operator just
            // confirmed.
            console.warn(
              `[storeReconciledOptions] rename refused (${renamePlan.reason}) ` +
                `for ${row._id} at level=${level}: ${renamePlan.message}`,
            );
          }
        }

        // Refresh-without-clobber (NEO-6, reworked onto slots for NEO-137):
        // refresh only the PRIMARY SLOT's marketplace ID per side and keep
        // operator-attached extras untouched.
        //
        // The primary slot KEY is deliberately reused rather than retired.
        // The reconciler is re-identifying the same logical set — a marketplace
        // re-slug changes the ID, not which set it is — and every card already
        // pointing at that slot must keep resolving. Retiring the key here
        // would orphan the whole checklist on a routine re-sync.
        //
        // NEO-211: a side with NO incoming id is no longer cleared here. That
        // is now the unlink pass's job, and it only fires on a side the caller
        // declared covered — so a SportLots outage cannot strip SL linkage off
        // every row it touches.
        const nextPrimary: { bsc?: string; sportlots?: string } = {
          ...(w.primaryPlatformId ?? {}),
        };
        for (const side of PLATFORM_SIDES) {
          const refreshedId = parsed.ids[side];
          if (!refreshedId) continue;
          // Name-tier rebinding onto a different id is the re-slug heal: the
          // slot key is reused so nothing orphans, but every card under this
          // row now points at a different marketplace set. Reported, never
          // silent.
          const previousId = primaryId(w, side);
          if (
            outcome.tier === 2 &&
            previousId !== undefined &&
            previousId !== refreshedId
          ) {
            relinkedAll.push({ id: row._id, value: w.value, side });
          }
          const rawLabel = item.platformLabels?.[side]?.[refreshedId];
          const labelCheck =
            rawLabel === undefined ? undefined : checkSelectorValue(rawLabel);
          const label =
            labelCheck && labelCheck.ok ? labelCheck.value : undefined;
          const next = setPrimarySlotId(w, side, refreshedId, label);
          w.platformData = next.platformData;
          w.platformLabels = next.platformLabels;
          // NEO-239 — a variantType sync knows the facet of the ids it just
          // fetched (it asked BSC for its `variant` values), so it tags them.
          // Every other level stays untagged: NEO-189's rule is that a slot is
          // tagged deliberately or not at all.
          const syncFacet = syncWrittenBscFacet(level);
          w.platformFacets =
            side === "bsc" && syncFacet && next.slot
              ? {
                  ...(next.platformFacets ?? {}),
                  bsc: { ...(next.platformFacets?.bsc ?? {}), [next.slot]: syncFacet },
                }
              : next.platformFacets;
          w.platformSlotSeq = next.platformSlotSeq;
          if (next.slot) nextPrimary[side] = next.slot;
          // A decline is a decision about ONE label; a new label re-opens it.
          const cleared = clearDeclinedIfLabelChanged(
            w.declinedUpstreamLabels,
            side,
            label,
          );
          if (cleared.changed) w.declinedUpstreamLabels = cleared.next;
        }
        w.primaryPlatformId =
          Object.keys(nextPrimary).length > 0 ? nextPrimary : undefined;

        // NEO-291 — the modal may carry a prefix for a row it is re-linking.
        // Same rule as the panel (`normalizeCardNumberPrefix`: an invalid one
        // throws the operator's sentence). Only a non-empty one is written:
        // `""` is not a value, and clearing is
        // `setSelectorOptionCardNumberPrefix`'s job (NEO-217 spelling).
        const incomingPrefix =
          item.metadata?.cardNumberPrefix === undefined
            ? undefined
            : normalizeCardNumberPrefix(item.metadata.cardNumberPrefix);
        if (incomingPrefix) {
          w.metadata = { ...(w.metadata ?? {}), cardNumberPrefix: incomingPrefix };
        }

        // NEO-239 — the base ROLE, from BSC's own base variant id, never from
        // the display value. ADDS ONLY: a row that already carries a value
        // keeps it, so an operator's `setBaseVariantType` decision survives
        // every later sync.
        if (w.metadata?.isBase === undefined && confersBaseRole(parsed.ids)) {
          w.metadata = { ...(w.metadata ?? {}), isBase: true };
        }

        // NEO-291 — same ADDS-ONLY rule for the insert/parallel flags: a row
        // carrying neither gets the derived pair, a row carrying either keeps
        // what it has. Never flipped here; a level move
        // (`applyParallelGroupings`) is the only thing that rewrites them.
        if (
          variantFlags &&
          w.metadata?.isInsert === undefined &&
          w.metadata?.isParallel === undefined
        ) {
          w.metadata = { ...(w.metadata ?? {}), ...variantFlags };
        }

        // NEO-296 — charge the budget only if this item actually dirtied the
        // row. A re-send of an already-stored list lands here and adds
        // nothing, so the next call's budget is free to reach the tail.
        if (Object.keys(pendingPatchFor(w)).length > 0) willPatch.add(row._id);

        linkedIds.push(row._id);
        continue;
      }

      // Fresh insert: reconciler is the only source of IDs, so the slots it
      // allocates are the primary on both sides.
      //
      // NEO-211 F4: the value and the labels are VALIDATED here, exactly as
      // the match path four lines up already validates its labels. This was
      // the last door writing a marketplace string straight into a row name —
      // an upstream title with a newline or 4 KB of markup would have become a
      // name no rename could fix (and `assertValidSlotLabel` would have thrown
      // mid-batch on the label, losing every item after it).
      const valueCheck = checkSelectorValue(item.value);
      if (!valueCheck.ok) {
        console.warn(
          `[storeReconciledOptions] skipped an unnameable item at ` +
            `level=${level}: ${valueCheck.reason}`,
        );
        continue;
      }
      const insertValue = valueCheck.value;
      const safeLabel = (side: "bsc" | "sportlots", id: string) => {
        const raw = item.platformLabels?.[side]?.[id];
        if (raw === undefined) return {};
        const checked = checkSelectorValue(raw);
        return checked.ok ? { label: checked.value } : {};
      };
      const bscIds = wireToIds(item.platformData.bsc);
      const slIds = wireToIds(item.platformData.sportlots);
      const alloc = initialSlots({
        bsc: bscIds.map((id) => ({ id, ...safeLabel("bsc", id) })),
        sportlots: slIds.map((id) => ({ id, ...safeLabel("sportlots", id) })),
      });

      // NEO-239 — tag the variantType level's BSC slots as `variant`, and
      // derive the base role from BSC's `base` id.
      const syncFacet = syncWrittenBscFacet(level);
      const insertFacets =
        syncFacet && bscIds.length > 0
          ? {
              ...alloc.platformFacets,
              bsc: {
                ...(alloc.platformFacets.bsc ?? {}),
                ...Object.fromEntries(
                  bscIds
                    .map((id) => alloc.slotByIdBySide.bsc[id])
                    .filter((slot): slot is string => !!slot)
                    .map((slot) => [slot, syncFacet] as const),
                ),
              },
            }
          : alloc.platformFacets;
      //
      // NEO-291 — the insert/parallel flags come from the derivation, never
      // from `item.metadata`, whose validator no longer admits them. The
      // prefix is the one thing the modal may still say about a new row.
      const insertPrefix =
        item.metadata?.cardNumberPrefix === undefined
          ? undefined
          : normalizeCardNumberPrefix(item.metadata.cardNumberPrefix);
      const insertMetadata = {
        ...(insertPrefix ? { cardNumberPrefix: insertPrefix } : {}),
        ...(confersBaseRole(parsed.ids) ? { isBase: true } : {}),
        ...(variantFlags ?? {}),
      };

      const newPrimary: { bsc?: string; sportlots?: string } = {};
      if (bscIds[0]) newPrimary.bsc = alloc.slotByIdBySide.bsc[bscIds[0]];
      if (slIds[0]) {
        newPrimary.sportlots = alloc.slotByIdBySide.sportlots[slIds[0]];
      }

      // NEO-291 — the derived flags reach `deriveOwnLevelFeatures` so the
      // write-once `features.cardType` snapshot is right at birth.
      const features = {
        ...(parentFeatures ?? {}),
        ...deriveOwnLevelFeatures(level, insertValue, variantFlags),
      };

      const hasLabels =
        Object.keys(alloc.platformLabels.bsc ?? {}).length > 0 ||
        Object.keys(alloc.platformLabels.sportlots ?? {}).length > 0;

      const id = await ctx.db.insert("selectorOptions", {
        level,
        value: insertValue,
        platformData: alloc.platformData,
        ...(hasLabels ? { platformLabels: alloc.platformLabels } : {}),
        ...(Object.keys(insertFacets.bsc ?? {}).length > 0
          ? { platformFacets: insertFacets }
          : {}),
        ...(Object.keys(newPrimary).length > 0
          ? { primaryPlatformId: newPrimary }
          : {}),
        ...(Object.keys(alloc.platformSlotSeq).length > 0
          ? { platformSlotSeq: alloc.platformSlotSeq }
          : {}),
        parentId,
        children: [],
        ...(Object.keys(insertMetadata).length > 0
          ? { metadata: insertMetadata }
          : {}),
        ...(Object.keys(features).length > 0 ? { features } : {}),
        ...(parentTeamIds ? { teamIds: parentTeamIds } : {}),
        lastUpdated: Date.now(),
      });
      inserts++;
      linkedIds.push(id);
    }

    // ── Unlink pass (NEO-211 D) ───────────────────────────────────────────
    //
    // Covered side + a primary id the fetch did not return = upstream dropped
    // it. Detach that one slot, report it, touch nothing else. Operator extras
    // stay: they are often ids from a DIFFERENT BSC facet than this level's
    // fetch queries (NEO-189), so "this fetch did not mention it" is no
    // evidence at all.
    const unlinkedAll: UnlinkedEntry[] = [];
    if (reconciledItems.length > 0) {
      for (const side of plan.coveredSides) {
        for (const row of existingOptions) {
          // NEO-239 — the `if (row.isCustom) continue` here was already a
          // no-op: `unlinkStalePrimary` returns nothing for a row with no
          // primary id on the side.
          const w = workingFor(row);
          const un = unlinkStalePrimary(w, side, plan.returnedIds[side]);
          if (!un) continue;
          w.platformData = un.platformData;
          w.platformLabels = un.platformLabels;
          w.platformFacets = un.platformFacets;
          w.primaryPlatformId = un.primaryPlatformId;
          unlinkedAll.push({ id: row._id, value: w.value, side });
        }
      }
    }

    // ── Write pass ────────────────────────────────────────────────────────
    //
    // NEO-85's write-if-changed guard, which this mutation never had: it used
    // to patch every matched row unconditionally, bumping `lastUpdated` and so
    // invalidating every query watching it — re-rendering and reflowing the
    // SetSelector columns under Maestro's coordinate taps on a sync that
    // changed nothing.
    let patches = 0;
    for (const w of working.values()) {
      const patch = pendingPatchFor(w);
      if (Object.keys(patch).length > 0) {
        await ctx.db.patch(w.row._id, { ...patch, lastUpdated: Date.now() });
        patches++;
      }
    }

    // `children` is a set-UNION now: it never loses a child, so a row the
    // reconciler did not name keeps its place in the parent's cache.
    if (parentId && linkedIds.length > 0) {
      const parent = await ctx.db.get(parentId);
      if (parent) {
        const next = unionChildren(parent.children, [
          ...linkedIds,
          ...existingOptions.map((o) => o._id),
        ]);
        if (!valuesDeepEqual(parent.children ?? [], next)) {
          await ctx.db.patch(parentId, { children: next });
          patches++;
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
    const heldElsewhereAll = [...heldElsewhereById.values()];
    const subtreeWalkSkipped = subtree?.skipped ?? false;
    if (heldElsewhereAll.length > 0 || withheldElsewhereAll.length > 0 || subtree) {
      // Ids and counts only — a row `value` is operator content.
      console.log(
        JSON.stringify({
          msg: "selector_sync_held_elsewhere",
          fn: "storeReconciledOptions",
          level,
          parentId: parentId ?? null,
          count: heldElsewhereAll.length,
          withheld: withheldElsewhereAll.length,
          subtreeReads: subtree?.reads ?? 0,
          subtreeWalkSkipped,
          rowIds: heldElsewhereAll.slice(0, 25).map((r) => r.id),
        }),
      );
    }

    // NEO-296 — every WRITE this transaction made: the fresh inserts, the row
    // patches, and the parent's `children` union. The reads (the sibling
    // collect, the ancestor walk, `annotateHasCards`) are the ~60 fixed
    // operations the budget already sets aside for and are not counted here.
    const writeOps = inserts + patches;
    const hasMore = itemsProcessed < reconciledItems.length;
    if (hasMore) {
      // Structured, and loud: a truncated store is the one result a caller
      // must not read as "done". Ids and counts only — a row `value` is
      // operator content and an incoming one is a marketplace string.
      console.warn(
        JSON.stringify({
          msg: "selector_sync_store_truncated",
          fn: "storeReconciledOptions",
          level,
          parentId: parentId ?? null,
          itemsSent: reconciledItems.length,
          itemsProcessed,
          writeOps,
          budget: writeBudget,
        }),
      );
    }

    return {
      success: true,
      message: hasMore
        ? `Stored ${linkedIds.length} reconciled ${level} options — ` +
          `${reconciledItems.length - itemsProcessed} of ${reconciledItems.length} ` +
          `not reached this time. Run the sync again to store the rest.`
        : `Successfully stored ${linkedIds.length} reconciled ${level} options`,
      optionsCount: linkedIds.length,
      unlinked,
      unlinkedTotal: unlinkedAll.length,
      relinked: relinkedAll.slice(0, UNLINK_NOTICE_LIMIT),
      relinkedTotal: relinkedAll.length,
      returnedIdsTruncatedSides: truncatedSides,
      itemsProcessed,
      hasMore,
      writeOps,
      heldElsewhere: heldElsewhereAll.slice(0, UNLINK_NOTICE_LIMIT),
      heldElsewhereTotal: heldElsewhereAll.length,
      withheldElsewhere: withheldElsewhereAll.slice(0, UNLINK_NOTICE_LIMIT),
      withheldElsewhereTotal: withheldElsewhereAll.length,
      subtreeWalkSkipped,
    };
  },
});
