"use node";

import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { requireAdmin } from "../auth";
import {
  recordAdapterCall,
  newRequestId,
  classifyAdapterError,
} from "../observability";

// Real BSC filter endpoint (ported from cardlister-server/script-frontend/src/listing-sites/bsc.ts).
// The earlier www.buysportscards.com URL was a webpage path, not an API — CloudFront returned 403.
const BSC_API_BASE = "https://api-prod.buysportscards.com";
const BSC_FILTERS_PATH = "/search/bulk-upload/filters";

// Per-attempt timeout for a single BSC marketplace fetch. The product owner
// caps any one shot at 10s (30s in one blocking call was too long to attribute
// a hang). We instead retry up to BSC_FETCH_MAX_ATTEMPTS within a ~30s ceiling.
const BSC_FETCH_TIMEOUT_MS = 10_000;
// Total attempts for the selector-filters fetch (1 initial + 2 retries).
const BSC_FETCH_MAX_ATTEMPTS = 3;
// Backoff between attempts: [attempt1→2, attempt2→3]. Length is
// BSC_FETCH_MAX_ATTEMPTS - 1.
const BSC_FETCH_BACKOFF_MS = [500, 1000];
// The card-checklist bulk-upload fetch is a single large request (up to 5000
// cards) that legitimately runs longer than a selector facet call, and it has
// its own 401-refresh-and-retry path rather than the 10s×3 selector loop. Keep
// its original 30s budget so this change doesn't regress large checklists.
const BSC_CHECKLIST_FETCH_TIMEOUT_MS = 30_000;

// NEO-90: per-card team lookup. Confirmed via live testing that this
// endpoint answers unauthenticated (it's public catalog data, not a
// seller-scoped call), so resolveBscCardTeam deliberately skips the
// bearer-token machinery above rather than depending on the fragile
// Puppeteer-backed BSC auth flow for a call that doesn't need it.
const BSC_TEAM_LOOKUP_TIMEOUT_MS = 10_000;
// Delay between cards in processBscTeamEnrichmentQueue. BSC has no
// confirmed rate limit, but this stays conservative against the same
// CDN/bot-detection this file already works around for the bulk
// endpoint (see bscHeaders below). Much shorter than Wikidata's 3s gap
// since there's no known limit to respect here — just don't hammer it.
const BSC_TEAM_ENRICH_DELAY_MS = 300;
// Bounded fan-out for fetchBscCardTeamNames's synchronous per-card lookups
// during fetchCardChecklist — matches the existing MAX_SL_FAN_OUT=10
// precedent in selectorOptions.ts for capping concurrent external calls.
const BSC_TEAM_LOOKUP_CONCURRENCY = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Map our levels to BSC API aggregation keys. BSC does NOT expose a
// NeonBinder → BSC facet mapping. NB's hierarchy differs from BSC's:
//   NB manufacturer  → SL only (no BSC facet)
//   NB setName       → BSC "setName" (e.g. "Topps")
//   NB variantType   → BSC "variant" (Base/Insert/Parallel)
//   NB insert        → BSC "variantName" (specific variant names)
//   NB parallel      → NB only (no BSC facet)
const LEVEL_TO_BSC_FACET: Record<string, string> = {
  sport: "sport",
  year: "year",
  setName: "setName",
  variantType: "variant",
  insert: "variantName",
};

// Browser-mimicking headers required by the BSC API (without these CloudFront
// rejects requests as bot traffic). `assumedrole: sellers` is mandatory and
// scopes the session to a seller context.
function bscHeaders(bearerToken: string): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-US,en;q=0.9",
    assumedrole: "sellers",
    "content-type": "application/json",
    origin: "https://www.buysportscards.com",
    referer: "https://www.buysportscards.com/",
    "Sec-Ch-Ua":
      '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": "macOS",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    authority: "api-prod.buysportscards.com",
    authorization: `Bearer ${bearerToken}`,
  };
}

/**
 * Get BSC bearer token from Secret Manager (browser service extraction).
 *
 * NEO-20: internalAction — never callable from frontend RPC. The
 * previous requireAdmin gate is removed because there is no longer
 * any legitimate non-backend caller; admin tools that need a token
 * must run as Convex actions themselves.
 */
export const getBscToken = internalAction({
  args: {
    // Optional correlation id from a parent aggregator call. When absent we
    // mint a fresh one so standalone getBscToken invocations are still
    // self-correlatable on the perf dashboard.
    requestId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    token: v.optional(v.string()),
    error: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{ success: boolean; token?: string; error?: string }> => {
    const requestId = args.requestId ?? newRequestId();
    const start = Date.now();
    try {
      const tokenResult = await ctx.runAction(
        internal.credentials.getSiteToken,
        { site: "buysportscards" },
      );

      if (tokenResult?.token) {
        await recordAdapterCall(ctx, {
          requestId,
          operation: "getBscToken",
          platform: "bsc",
          duration_ms: Date.now() - start,
          success: true,
        });
        return { success: true, token: tokenResult.token };
      }

      await recordAdapterCall(ctx, {
        requestId,
        operation: "getBscToken",
        platform: "bsc",
        duration_ms: Date.now() - start,
        success: false,
        error_class: "no_credentials",
      });
      return {
        success: false,
        error: "No BSC token available. Connect your BSC account first.",
      };
    } catch (error) {
      console.error("[getBscToken] Error:", error);
      await recordAdapterCall(ctx, {
        requestId,
        operation: "getBscToken",
        platform: "bsc",
        duration_ms: Date.now() - start,
        success: false,
        error_class: classifyAdapterError(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return {
        success: false,
        error: `Failed to get BSC token: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

/**
 * Call the BSC bulk-upload API to get available filter options for a level
 */
export const fetchBscSelectorOptions = action({
  args: {
    level: v.string(),
    parentFilters: v.object({
      sport: v.optional(v.string()),
      year: v.optional(v.string()),
      manufacturer: v.optional(v.string()),
      setName: v.optional(v.string()),
      variantType: v.optional(v.string()),
    }),
    // Pre-resolved BSC slugs keyed by level (e.g., { sport: ["basketball"], year: ["2024"] }).
    // When provided, these are used instead of parentFilters for the BSC API call.
    platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
    // Optional correlation id from a parent aggregator call. When absent we
    // mint a fresh one so standalone calls are still self-correlatable.
    requestId: v.optional(v.string()),
  },
  returns: v.object({
    success: v.boolean(),
    options: v.array(
      v.object({
        value: v.string(),
        platformValue: v.string(),
      }),
    ),
    message: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{ success: boolean; options: Array<{ value: string; platformValue: string }>; message?: string }> => {
    await requireAdmin(ctx);
    const requestId = args.requestId ?? newRequestId();
    const start = Date.now();
    let tokenMs: number | undefined;
    let filtersCallMs: number | undefined;
    let statusCode: number | undefined;
    try {
      // Get BSC token
      const tokenStart = Date.now();
      const tokenResult: { success: boolean; token?: string; error?: string } = await ctx.runAction(
        internal.adapters.buysportscards.getBscToken,
        { requestId },
      );
      tokenMs = Date.now() - tokenStart;

      if (!tokenResult.success || !tokenResult.token) {
        await recordAdapterCall(ctx, {
          requestId,
          operation: "fetchBscSelectorOptions",
          platform: "bsc",
          level: args.level,
          parentSport: args.parentFilters.sport,
          parentYear: args.parentFilters.year,
          parentSetName: args.parentFilters.setName,
          duration_ms: Date.now() - start,
          token_ms: tokenMs,
          success: false,
          error_class: "no_credentials",
        });
        return {
          success: false,
          options: [],
          message: tokenResult.error || "No BSC token available",
        };
      }

      // Build nested filters matching the BSC bulk-upload/filters shape.
      // NB levels are mapped to BSC facets via LEVEL_TO_BSC_FACET.
      // Levels without a BSC facet (manufacturer, parallel) are skipped.
      const filters: Record<string, string[]> = {};

      if (args.platformFilters) {
        // Use pre-resolved BSC slugs — map NB level names to BSC facet keys
        for (const [lvl, values] of Object.entries(args.platformFilters)) {
          const facet = LEVEL_TO_BSC_FACET[lvl];
          if (facet) {
            filters[facet] = values;
          }
        }
      } else {
        // Fallback: use display labels (only correct for top-level sport sync
        // where there are no parent filters)
        if (args.parentFilters.sport) {
          filters.sport = [args.parentFilters.sport];
        }
        if (args.parentFilters.year) {
          filters.year = [args.parentFilters.year];
        }
        // manufacturer has no BSC facet — SL only
        if (args.parentFilters.setName) {
          filters.setName = [args.parentFilters.setName];
        }
        if (args.parentFilters.variantType) {
          filters.variant = [args.parentFilters.variantType];
        }
      }

      const facetKey = LEVEL_TO_BSC_FACET[args.level];
      if (!facetKey) {
        await recordAdapterCall(ctx, {
          requestId,
          operation: "fetchBscSelectorOptions",
          platform: "bsc",
          level: args.level,
          parentSport: args.parentFilters.sport,
          parentYear: args.parentFilters.year,
          parentSetName: args.parentFilters.setName,
          duration_ms: Date.now() - start,
          token_ms: tokenMs,
          success: false,
          stage: "adapter",
          error_class: "unsupported_level",
        });
        return {
          success: false,
          options: [],
          message: `BSC has no aggregation for level: ${args.level}`,
        };
      }

      // Bounded retry loop for the selector-filters fetch. Per attempt we
      // cap at BSC_FETCH_TIMEOUT_MS (10s). We retry on transient failures —
      // a per-attempt timeout, a network throw, or a 5xx/429 status — and
      // stop immediately on a 2xx (success) or a permanent 4xx (non-429),
      // which won't improve on retry. Up to BSC_FETCH_MAX_ATTEMPTS total.
      let response: Response | undefined;
      let attempt = 0;
      let lastErrorMsg = "";
      const filtersStart = Date.now();
      while (attempt < BSC_FETCH_MAX_ATTEMPTS) {
        attempt += 1;
        let attemptStatus: number | undefined;
        try {
          const resp = await fetch(`${BSC_API_BASE}${BSC_FILTERS_PATH}`, {
            method: "POST",
            headers: bscHeaders(tokenResult.token),
            body: JSON.stringify({ filters }),
            signal: AbortSignal.timeout(BSC_FETCH_TIMEOUT_MS),
          });
          attemptStatus = resp.status;
          statusCode = resp.status;

          if (resp.ok) {
            // Success — keep this response and break out of the loop.
            response = resp;
            break;
          }

          // Non-ok: decide retry vs. permanent failure by status.
          const retryableStatus = resp.status >= 500 || resp.status === 429;
          if (!retryableStatus) {
            // Permanent 4xx (non-429) — won't improve on retry. Keep the
            // response and break so the non-ok handler below records it.
            response = resp;
            break;
          }
          // Retryable status: drain the body to free the socket, record the
          // message, and fall through to backoff/retry.
          const errText = await resp.text().catch(() => "");
          lastErrorMsg = `BSC API ${resp.status}`;
          console.error(
            `[fetchBscSelectorOptions] BSC API ${resp.status} (attempt ${attempt}/${BSC_FETCH_MAX_ATTEMPTS}): ${errText.slice(0, 300)}`,
          );
        } catch (err) {
          const isTimeout = err instanceof Error && err.name === "TimeoutError";
          lastErrorMsg = isTimeout
            ? `BSC API request timed out after ${BSC_FETCH_TIMEOUT_MS / 1000}s`
            : `BSC API request failed: ${err instanceof Error ? err.message : String(err)}`;
          console.error(
            `[fetchBscSelectorOptions] ${lastErrorMsg} (attempt ${attempt}/${BSC_FETCH_MAX_ATTEMPTS})`,
          );
          // Timeout or network throw — retryable. Fall through to backoff.
        }

        // Exhausted all attempts with a retryable failure — give up.
        if (attempt >= BSC_FETCH_MAX_ATTEMPTS) {
          filtersCallMs = Date.now() - filtersStart;
          const msg = lastErrorMsg || "BSC API request failed";
          const timedOut = msg.includes("timed out");
          await recordAdapterCall(ctx, {
            requestId,
            operation: "fetchBscSelectorOptions",
            platform: "bsc",
            level: args.level,
            parentSport: args.parentFilters.sport,
            parentYear: args.parentFilters.year,
            parentSetName: args.parentFilters.setName,
            duration_ms: Date.now() - start,
            token_ms: tokenMs,
            filters_call_ms: filtersCallMs,
            status_code: attemptStatus,
            success: false,
            stage: "marketplace_fetch",
            attempt,
            timed_out_platform: timedOut ? "bsc" : undefined,
            error_class: classifyAdapterError(msg),
          });
          return { success: false, options: [], message: msg };
        }

        // Sleep the backoff between attempts (not after the last).
        const backoff = BSC_FETCH_BACKOFF_MS[attempt - 1] ?? 0;
        if (backoff > 0) await sleep(backoff);
      }

      filtersCallMs = Date.now() - filtersStart;

      // After the loop `response` is always set: either a 2xx (success) or a
      // permanent non-retryable status that broke out early.
      if (!response || !response.ok) {
        const status = response?.status ?? statusCode;
        const errText = response ? await response.text().catch(() => "") : "";
        console.error(
          `[fetchBscSelectorOptions] BSC API ${status} (attempt ${attempt}/${BSC_FETCH_MAX_ATTEMPTS}): ${errText.slice(0, 300)}`,
        );
        await recordAdapterCall(ctx, {
          requestId,
          operation: "fetchBscSelectorOptions",
          platform: "bsc",
          level: args.level,
          parentSport: args.parentFilters.sport,
          parentYear: args.parentFilters.year,
          parentSetName: args.parentFilters.setName,
          duration_ms: Date.now() - start,
          token_ms: tokenMs,
          filters_call_ms: filtersCallMs,
          status_code: status,
          success: false,
          stage: "marketplace_fetch",
          attempt,
          error_class: classifyAdapterError(`BSC API ${status}`),
        });
        return {
          success: false,
          options: [],
          message: `BSC API error: ${status}`,
        };
      }

      // Response shape: { aggregations: { sport: Filter[], year: Filter[], ... } }
      // where Filter = { label: string, slug: string, count: number, active: boolean }
      const data = await response.json() as {
        aggregations?: Record<
          string,
          Array<{ label?: string; slug?: string; count?: number; active?: boolean }>
        >;
      };
      const levelFacet = data.aggregations?.[facetKey] ?? [];

      const options: Array<{ value: string; platformValue: string }> = [];
      for (const item of levelFacet) {
        // Skip facet entries with zero inventory — BSC returns them but
        // they're not actually available options.
        if (typeof item.count === "number" && item.count <= 0) continue;
        const label = item.label?.trim();
        const slug = item.slug?.trim();
        if (!label || !slug) continue;
        options.push({
          value: label,
          platformValue: slug,
        });
      }

      await recordAdapterCall(ctx, {
        requestId,
        operation: "fetchBscSelectorOptions",
        platform: "bsc",
        level: args.level,
        parentSport: args.parentFilters.sport,
        parentYear: args.parentFilters.year,
        parentSetName: args.parentFilters.setName,
        duration_ms: Date.now() - start,
        token_ms: tokenMs,
        filters_call_ms: filtersCallMs,
        status_code: statusCode,
        success: true,
        stage: "marketplace_fetch",
        attempt,
        result_count: options.length,
      });

      return {
        success: true,
        options,
        message: `Found ${options.length} ${args.level} options from BSC`,
      };
    } catch (error) {
      console.error("[fetchBscSelectorOptions] Error:", error);
      await recordAdapterCall(ctx, {
        requestId,
        operation: "fetchBscSelectorOptions",
        platform: "bsc",
        level: args.level,
        parentSport: args.parentFilters.sport,
        parentYear: args.parentFilters.year,
        parentSetName: args.parentFilters.setName,
        duration_ms: Date.now() - start,
        token_ms: tokenMs,
        filters_call_ms: filtersCallMs,
        status_code: statusCode,
        success: false,
        error_class: classifyAdapterError(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return {
        success: false,
        options: [],
        message: `BSC error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

/**
 * Validator for the per-card payload returned by fetchBscChecklist
 * and accepted by the SportLots adapter (with most fields left empty).
 * Carries everything we can source at *checklist* time. Per-copy fields
 * (grade, condition, cert) belong on a future cardInventory table.
 *
 * Team is intentionally optional and usually empty — BSC's bulk-upload
 * catalog endpoint doesn't carry a real team field of its own (it lives on
 * listings, not the catalog template). The one exception: Team Checklist
 * cards embed the team name directly in `players` (e.g. "Kansas City
 * Royals TC"), which `parsePlayersField` detects and surfaces here. For
 * every other card, team stays unresolved at checklist time — a future
 * enrichment (the player's career history via Wikidata, or a user prompt)
 * would populate it for regular player cards; out of scope for this file.
 */
const checklistCardValidator = v.object({
  cardNumber: v.string(),
  cardName: v.string(),
  // Optional fallback for callers that have a team display string handy.
  team: v.optional(v.string()),
  teams: v.optional(v.array(v.string())),
  players: v.optional(v.array(v.string())),
  // De-duped union of BSC playerAttribute tokens + variant-derived flags.
  attributes: v.optional(v.array(v.string())),
  printRun: v.optional(v.number()),
  autographType: v.optional(v.string()),
  cardVariation: v.optional(v.string()),
  platformRef: v.optional(v.string()),
  sportlotsRef: v.optional(v.string()),
  // NEO-6: the BSC source-set slug this card came from (e.g.
  // "2022-topps-baseball" vs "2022-topps-baseball-update"). Populated from
  // raw `r.setName` so callers can tell which attached BSC set produced
  // the card when the variant has multiple BSC IDs attached.
  sourceBscSetSlug: v.optional(v.string()),
});

/**
 * Parse a BSC printRun field — varies between number, "/99" string, and
 * "99" string. Returns undefined for unnumbered cards.
 */
function parsePrintRun(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[^0-9]/g, "");
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Coerce a BSC field that may be string | string[] | undefined into a
 * deduped string[]. Empty strings are dropped.
 */
function asStringArray(raw: unknown): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of arr) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

/**
 * Parse BSC's `playerAttribute` field (a comma-separated string like
 * "RC", "SP, VAR", or "AU, RC") into a normalized de-duped token array
 * we treat as card attributes.
 */
function parsePlayerAttributeTokens(raw: unknown): string[] {
  if (!raw) return [];
  const flatString = Array.isArray(raw) ? raw.join(",") : String(raw);
  const tokens = flatString
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return Array.from(new Set(tokens));
}

/**
 * NEO-189: markers that mean `playerAttributeDesc` names a genuine printing
 * VARIETY — something that distinguishes this physical card from another card
 * carrying the same checklist slot, and therefore something a buyer is
 * selecting on:
 *
 *   VAR — a variation ("VAR: Action", "VAR: Team Color", "VAR: Nickname")
 *   UER — an uncorrected error, the hobby's own term for a misprint that was
 *         never fixed mid-run, and which collectors price separately
 *
 * Everything else in that field is a NOTE, not a variety. See
 * `parseVariationDescription` for why the distinction is load-bearing.
 */
const BSC_VARIETY_MARKERS = new Set(["VAR", "UER"]);

/**
 * NEO-189 — split a BSC `cardNo` into its numeric STEM and alpha suffix.
 * `"11"` → stem `11`, no suffix. `"11b"` → stem `11`, suffix `b`. `"1a"` →
 * stem `1`, suffix `a`. Anything not of that shape (`"CC-JA"`, `"MIR-AJ"`) has
 * no stem and groups only with an exact match on itself.
 *
 * Case-insensitive on purpose: 2022 Topps Heritage carries a single uppercase
 * `"…C"` among 297 otherwise-lowercase suffixes.
 */
const BSC_CARD_NO_STEM = /^(\d+)([a-z]+)$/i;

export function bscCardNumberStem(cardNumber: string): string {
  const m = cardNumber.trim().match(BSC_CARD_NO_STEM);
  return m ? m[1] : cardNumber.trim();
}

/**
 * NEO-189 — is this row a printing VARIATION of some other card?
 *
 * Reads BOTH signals, because measured across seven live BSC payloads they
 * disagree in both directions:
 *
 *   2021 Topps base       11 rows carry the `VAR` attribute token with no
 *                         `VAR:` description
 *   2021 Heritage insert   4 rows carry a `VAR:` description with no `VAR`
 *                         attribute token (the #251 / #378 checklist
 *                         print variations)
 *
 * Neither signal alone is sufficient, so this is a union, not an intersection.
 */
export function isBscVariationRow(row: {
  attributes?: string[];
  playerAttributeDesc?: unknown;
}): boolean {
  if (row.attributes?.some((t) => t.trim().toUpperCase() === "VAR")) return true;
  const parsed = parseVariationDescription(row.playerAttributeDesc);
  return parsed?.marker === "VAR";
}

export interface ParsedVariationDescription {
  /** The marker BSC prefixed the text with, without the colon — "VAR",
   *  "BASE", "UER". Undefined when the description carried no prefix. */
  marker?: string;
  /** The residual text with the marker stripped. Never empty. */
  text: string;
  /** True when `marker` names a real printing variety (see
   *  `BSC_VARIETY_MARKERS`) — i.e. when `text` is safe to surface as the
   *  card's variety name. */
  isVariety: boolean;
}

/**
 * Parse BSC's `playerAttributeDesc` into its marker and residual text.
 *
 * NEO-189 — WHY THIS RETURNS A MARKER INSTEAD OF A BARE STRING:
 *
 * This function used to strip any `^[A-Z]{2,4}:` prefix and return whatever
 * was left, and the caller fed that straight into `cardVariation`. But BSC
 * overloads this one field for three unrelated things, and only one of them
 * is a variety. Measured against the live 2021 Topps Heritage base set (908
 * rows, pulled 2026-08-27), the descriptions that carry text break down as:
 *
 *   VAR: …    183 rows   a real variation — "Action", "Team Color", "Nickname"
 *   BASE…      21 rows   says only "this is the base card" — "BASE", "BASE: posed"
 *   UER: …      1 row    an uncorrected error, also a real variety
 *   (none)     29 rows   a free-text shelf note
 *
 * So **51 of 908 rows** (the BASE and unprefixed ones) were populating
 * `cardVariation` with something that is not a variety name at all. Card #10
 * got `"Puzzle piece B2 on back; see Comments"`; #17 got the literal
 * `"BASE"`; and #99's `"BASE: posed"` had its prefix stripped down to a bare
 * `"posed"`, which reads as a variety name but is not one.
 *
 * That mattered because `cardVariation` is not display-only. It flows into
 * `deriveCardFeatures` as `parallelName` (`features/deriveCardFeatures.ts:243`),
 * which the marketplace audit maps to **eBay's Parallel/Variety aspect**, and
 * it is appended to the card's label in the set builder
 * (`components/SetSelector/CardChecklistItem.tsx:120`). Left alone, building
 * out production set data would have baked a shelf note into the eBay listing
 * aspect of roughly one card in eighteen.
 *
 * Returning the marker rather than pre-deciding also gives NEO-189's grouping
 * pass the `VAR` signal it needs without re-parsing the raw field.
 *
 * Returns undefined when there is no text at all.
 */
export function parseVariationDescription(
  raw: unknown,
): ParsedVariationDescription | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const prefixed = trimmed.match(/^([A-Z]{2,4}):\s*(.*)$/);
  if (!prefixed) {
    // No marker — a free-text note. Carried so a caller that wants notes can
    // have them, but never a variety.
    return { text: trimmed, isVariety: false };
  }

  const marker = prefixed[1];
  const rest = prefixed[2].trim();
  // A bare marker with nothing after it ("BASE:") carries no information
  // beyond the marker itself; keep the marker as the text so the result is
  // never empty.
  const text = rest || marker;
  return { marker, text, isVariety: BSC_VARIETY_MARKERS.has(marker) && !!rest };
}

export interface VariationLinkInput {
  cardNumber: string;
  attributes?: string[];
  playerAttributeDesc?: unknown;
}

/**
 * NEO-189 — decide, for each row, which other row it is a variation OF.
 *
 * Returns a map from the variation's `cardNumber` to its parent's
 * `cardNumber`. A row absent from the map is not a variation.
 *
 * ── THE RULE, AND WHY IT IS NOT THE OBVIOUS ONE ─────────────────────────────
 *
 * The obvious rule — "a bare number is the parent, an alpha suffix means
 * child" — is WRONG, and measurably so. Validated against seven live BSC
 * payloads pulled 2026-08-27:
 *
 *   set                          groups w/ a variation   bare-is-parent   this rule
 *   2021 Topps Heritage base              77                  77/77         77/77
 *   2022 Topps Heritage base             144                 144/144       144/144
 *   2021 Topps base                      152                   2/152       152/152   <—
 *   2021 Donruss football base            50                  50/50         50/50
 *   2021 Panini Prizm basketball base     36                  36/36         36/36
 *
 * 2021 Topps is the counter-example: its base cards are themselves suffixed.
 * Card #1 does not exist — the set ships `1a` "BASE: Rounding Base"
 * (Fernando Tatis Jr.), `1b` "VAR: Sliding" (SP), `1c` "VAR: In Dugout" (SSP).
 * 150 of its 660 stems have no bare-numbered row at all. A bare-is-parent rule
 * gets 2 of 152 groups right there.
 *
 * What DOES hold, across all 459 variation groups in the five base sets:
 * group by numeric stem, and **exactly one row in the group is not marked as a
 * variation**. That row is the parent, whatever its number looks like.
 *
 * ── WHERE IT STILL DOES NOT HOLD ───────────────────────────────────────────
 *
 * The `insert` level is a different world and this function deliberately does
 * not force a link there. In 2021 Topps Heritage inserts:
 *
 *   #251  two rows, both "VAR:" (Large Print / Small Print), NO parent row
 *   #378  two rows, both "VAR:" (Star / Asterisk before copyright), NO parent
 *   #18   Juan Pizarro twice, both VAR (Yellow / Green under C and S),
 *         same cardNo, NO suffix
 *
 * So a group can have zero parents, and two variations can share one
 * `cardNumber` with nothing to tell them apart but their BSC `cardId`. Rows in
 * such a group are left unlinked and reported, rather than guessed at — see
 * `unresolvedVariationStems` on the return. They are also exactly the rows that
 * would collide in `commitCardChecklist`'s `existingByNumber` upsert, so the
 * caller must not silently upsert them.
 *
 * ── DO NOT ADD A "SAME PLAYER" GUARD ───────────────────────────────────────
 *
 * It looks like an easy safety net and it is actively wrong. A variation
 * routinely features a COMPLETELY DIFFERENT player from its parent — the
 * hobby's "Legend" short-print convention:
 *
 *   2021 Topps #52   base = Archie Bradley
 *                    52b  = Mickey Mantle   (SP,  "VAR: Legend; Batting")
 *                    52c  = Mickey Mantle   (SSP, "VAR: Legend; Holding three bats")
 *   2021 Topps #4    base = David Bote  →  4b  = Ernie Banks    ("VAR: Legend")
 *   2021 Topps #29   base = Chris Davis →  29b = Cal Ripken Jr. ("VAR: Legend")
 *   2022 Heritage #201  base = a team-highlight card → 201b-f = Aaron Judge
 *
 * Requiring player overlap was measured against the corpus and drops 63 of 213
 * legitimate links in 2021 Topps alone, plus 9 in 2021 Heritage, 6 in 2022
 * Heritage and 1 in Prizm. It is not a viable guard.
 *
 * ── SCOPE THE INPUT TO ONE MARKETPLACE SET ─────────────────────────────────
 *
 * This groups purely on the numeric stem, so it is only sound when `rows`
 * covers ONE BSC set. Run over a payload spanning several and unrelated cards
 * collide: querying every 2021 Heritage insert at once puts Bill Bonham's
 * "VAR: Yellow under C and S" at #29 in the same stem as Deivi Garcia's #29,
 * and they link. The structure is indistinguishable from the legitimate
 * Mantle/Bradley case above — only the scoping tells them apart.
 *
 * `fetchCardChecklist` fetches per selectorOption row, so the normal path is
 * fine. The case that needs care is NEO-137's N:M mapping, where one NB row
 * fans out across several BSC sets: group per source set, not across the
 * merged result.
 */
export function resolveVariationParents(rows: VariationLinkInput[]): {
  /** variation cardNumber → parent cardNumber */
  parentByCardNumber: Map<string, string>;
  /** stems where a variation exists but no single parent could be identified */
  unresolvedVariationStems: string[];
} {
  const byStem = new Map<string, VariationLinkInput[]>();
  for (const row of rows) {
    const stem = bscCardNumberStem(row.cardNumber);
    const bucket = byStem.get(stem);
    if (bucket) bucket.push(row);
    else byStem.set(stem, [row]);
  }

  const parentByCardNumber = new Map<string, string>();
  const unresolvedVariationStems: string[] = [];

  for (const [stem, group] of byStem) {
    const variations = group.filter((r) => isBscVariationRow(r));
    if (variations.length === 0) continue;

    const parents = group.filter((r) => !isBscVariationRow(r));
    // Zero parents (an orphaned checklist variation) or more than one (a stem
    // shared by unrelated cards, which happens once insert subsets are
    // flattened together) — both are ambiguous. Report, do not guess.
    if (parents.length !== 1) {
      unresolvedVariationStems.push(stem);
      continue;
    }
    const parentNumber = parents[0].cardNumber;
    for (const v of variations) {
      // Two variations sharing one cardNumber cannot both be addressed by
      // number. Flag the stem rather than letting the second silently
      // overwrite the first downstream.
      if (parentByCardNumber.has(v.cardNumber)) {
        unresolvedVariationStems.push(stem);
        parentByCardNumber.delete(v.cardNumber);
        break;
      }
      parentByCardNumber.set(v.cardNumber, parentNumber);
    }
  }

  return { parentByCardNumber, unresolvedVariationStems };
}

/**
 * Known BSC card-type suffixes that mean "this string names a TEAM, not a
 * player" — e.g. "Kansas City Royals TC" (Team Checklist). Confirmed live
 * against a real 2026 Topps Baseball base set (24 TC rows out of 708, incl.
 * single-word team names like "Athletics"/"Angels" — suffix-stripping must
 * not assume multi-word). Extensible: add more here if/when a new one is
 * confirmed against real data — don't guess at unconfirmed tokens.
 */
const TEAM_CARD_SUFFIXES = ["TC"];

/**
 * Parse BSC's raw `players` field (a single string) into clean player
 * names, any detected team name, and — for multi-player insert cards whose
 * player list is wrapped in parens with descriptive text around it (e.g.
 * League Leaders, or other duo/trio insert types) — the surrounding
 * descriptive text for use in `cardName`.
 *
 * Replaces a naive comma/slash split on the whole string, which breaks
 * on two real BSC conventions (confirmed live against a real 708-card base
 * set, 49 affected rows — ~7%, not an edge case):
 *   - Team Checklist cards: "Kansas City Royals TC" was treated as one
 *     bogus "player" instead of a team.
 *   - Multi-player insert cards: "National League Leaders RBI (Kyle
 *     Schwarber, Pete Alonso, Juan Soto) LL" — the blind split cut the
 *     comma INSIDE the parens, producing two garbage half-strings.
 */
export function parsePlayersField(raw: string): {
  players: string[];
  teams: string[];
  namePrefix?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { players: [], teams: [] };

  // 1. Team-card suffix — the whole string names a team, not a player.
  // Reported into BOTH players and teams: the team entity links via the
  // existing teamOnCardIds field, and a matching players row is created
  // too so the card can also link via playerIds (explicit product choice —
  // see the plan this implements).
  for (const suffix of TEAM_CARD_SUFFIXES) {
    const suffixPattern = new RegExp(`\\s+${suffix}$`);
    if (suffixPattern.test(trimmed)) {
      const teamName = trimmed.replace(suffixPattern, "").trim();
      if (teamName) return { players: [teamName], teams: [teamName] };
    }
  }

  // 2. Parenthetical player list — e.g. "<description> (<players>) <tag>".
  // Extract names from INSIDE the parens (safe to comma/slash-split there,
  // isolated from the surrounding text); combine whatever text sits before
  // AND after the parens into namePrefix (real data has both — a leading
  // description like "National League Leaders RBI" AND a trailing tag like
  // "LL"/"CPC"). Generic on purpose: validated against two different real
  // insert types, not hardcoded to League Leaders.
  const parenMatch = trimmed.match(/^(.*)\(([^)]*)\)(.*)$/);
  if (parenMatch) {
    const [, before, inside, after] = parenMatch;
    const players = inside
      .split(/\s*[/,]\s*/)
      .map((p) => p.trim())
      .filter(Boolean);
    const namePrefix = `${before.trim()} ${after.trim()}`
      .trim()
      .replace(/\s+/g, " ");
    return {
      players,
      teams: [],
      ...(namePrefix ? { namePrefix } : {}),
    };
  }

  // 3. Fallback — today's behavior: a plain single- or multi-player string.
  const players = trimmed
    .split(/\s*[/,]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  return { players, teams: [] };
}

/**
 * Fetch card checklist from BSC for a specific set/variant.
 *
 * Uses POST /search/bulk-upload/results — BSC's catalog endpoint. This
 * returns the same set of cards every authenticated user sees on the
 * "Bulk Upload" page; it does NOT scope to a specific seller's listings.
 * That means dev/test accounts without inventory get the same data as
 * a seasoned seller, and we don't need a per-user sellerId for fetch
 * (any valid bearer token authenticates).
 *
 * Trade-off vs the older /search/seller/results endpoint we ported
 * from the 2022 cardlister script: this endpoint is slimmer. It does
 * NOT carry team, printRun, autograph, features[], or sportlots
 * cross-reference fields. Those are listing-level concerns (per-copy)
 * that we'll source at list time from the player's Wikidata career
 * history or a user prompt.
 *
 * Response shape: a flat JSON array (not wrapped in `{ results, total }`).
 */
export const fetchBscChecklist = action({
  args: {
    parentFilters: v.record(v.string(), v.string()),
    // Pre-resolved BSC slugs keyed by level (e.g., { sport: ["basketball"] }).
    platformFilters: v.optional(v.record(v.string(), v.array(v.string()))),
  },
  returns: v.object({
    success: v.boolean(),
    cards: v.array(checklistCardValidator),
    message: v.optional(v.string()),
  }),
  handler: async (ctx, args): Promise<{ success: boolean; cards: Array<{ cardNumber: string; cardName: string; team?: string; teams?: string[]; players?: string[]; attributes?: string[]; printRun?: number; autographType?: string; cardVariation?: string; platformRef?: string; sportlotsRef?: string; sourceBscSetSlug?: string }>; message?: string }> => {
    await requireAdmin(ctx);
    try {
      const tokenResult: { success: boolean; token?: string; error?: string } = await ctx.runAction(
        internal.adapters.buysportscards.getBscToken,
        {},
      );

      if (!tokenResult.success || !tokenResult.token) {
        return {
          success: false,
          cards: [],
          message: tokenResult.error || "No BSC token available",
        };
      }

      // Build nested `filters: { sport: [...], year: [...], ... }`.
      // For most levels (sport/year/setName) we trust the pre-resolved BSC
      // slugs from `platformFilters`. variantType is a tiny enum
      // (base/insert/parallel) where the BSC slug always equals the
      // lowercased display value, so we derive it directly from
      // `parentFilters.variantType`. This avoids a class of bug where the
      // variant entity's `platformData.bsc` got corrupted by an earlier
      // mis-saved BaseSetPicker mapping (the slug ended up pointing at
      // the parent setName instead of the variant) — confirmed live in
      // dev. Sourcing variant from the display value is robust regardless
      // of what's on the variant entity.
      const filters: Record<string, string[]> = {};
      if (args.platformFilters) {
        for (const [lvl, values] of Object.entries(args.platformFilters)) {
          if (lvl === "variantType") continue; // see comment above
          const facet = LEVEL_TO_BSC_FACET[lvl];
          if (facet) {
            filters[facet] = values;
          }
        }
      } else {
        if (args.parentFilters.sport) {
          filters.sport = [args.parentFilters.sport.toLowerCase()];
        }
        if (args.parentFilters.year) {
          filters.year = [args.parentFilters.year];
        }
        // manufacturer has no BSC facet — SL only
        if (args.parentFilters.setName) {
          filters.setName = [args.parentFilters.setName];
        }
      }
      if (args.parentFilters.variantType) {
        filters.variant = [args.parentFilters.variantType.toLowerCase()];
      }

      // FAN OUT — one request per variantName slug. Do NOT batch them.
      //
      // Measured live on dev 2026-08-12, 1996 Score inserts:
      //   filters.variantName = ["…series-2"]                  -> returned=110
      //   filters.variantName = ["…series-2", "…series-1"]      -> returned=0
      // BSC answers 200 OK with an EMPTY body for a multi-value facet — it does
      // not OR them. The comment that used to sit here claimed the opposite
      // ("accepts multi-value facets in one call … no fan-out needed"); it was
      // never true and nothing caught it, because the checklist tests mock this
      // adapter at the validator boundary and never sent two values.
      //
      // The failure mode is silent and nasty: a well-formed query, no error, an
      // empty checklist, and a UI that reports "0 BSC cards" as though the
      // marketplace simply had nothing.
      //
      // Sequential, not parallel: the 401 path refreshes `activeToken` and the
      // refreshed value has to be visible to the requests that follow.
      const MAX_CARDS = 5000;
      const variantNames = filters.variantName ?? [];
      const fanOut: Array<string | undefined> =
        variantNames.length > 0 ? variantNames : [undefined];

      let activeToken = tokenResult.token;

      type OneResult =
        | { ok: true; raw: Record<string, unknown>[] }
        | { ok: false; message: string };

      const runOne = async (slug: string | undefined): Promise<OneResult> => {
        const callFilters: Record<string, string[]> = slug
          ? { ...filters, variantName: [slug] }
          : filters;
        // BSC's /search/bulk-upload/results ignores `size`/`page` and returns
        // the full filtered set in one response — confirmed live. `size` is
        // passed as a defense in case that changes.
        const body = {
          condition: "all",
          page: 0,
          size: MAX_CARDS,
          sort: "default",
          filters: callFilters,
        };
        const doFetch = async (token: string): Promise<Response> =>
          await fetch(`${BSC_API_BASE}/search/bulk-upload/results`, {
            method: "POST",
            headers: bscHeaders(token),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(BSC_CHECKLIST_FETCH_TIMEOUT_MS),
          });

        let response: Response;
        try {
          response = await doFetch(activeToken);
        } catch (err) {
          const isTimeout = err instanceof Error && err.name === "TimeoutError";
          return {
            ok: false,
            message: isTimeout
              ? `BSC API request timed out after ${BSC_CHECKLIST_FETCH_TIMEOUT_MS / 1000}s`
              : `BSC API request failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        // BSC intermittently 401s with a token our cache still thinks is fresh
        // (their TTL doesn't always match what they advertise, especially under
        // load). Refresh and retry once rather than failing the whole fetch.
        if (response.status === 401) {
          console.warn(
            `[fetchBscChecklist] BSC API 401 with cached token — forcing re-auth and retrying once`,
          );
          await response.text().catch(() => "");
          const reAuth = (await ctx.runAction(
            internal.credentials.authenticateBsc,
            {},
          )) as { success: boolean; message?: string };
          if (!reAuth.success) {
            console.error(
              `[fetchBscChecklist] re-auth failed after 401: ${reAuth.message ?? "(no message)"}`,
            );
            return { ok: false, message: `BSC API 401 and re-auth failed` };
          }
          const refreshed: { success: boolean; token?: string; error?: string } =
            await ctx.runAction(internal.adapters.buysportscards.getBscToken, {});
          if (!refreshed.success || !refreshed.token) {
            return {
              ok: false,
              message: refreshed.error || "No BSC token available after re-auth",
            };
          }
          activeToken = refreshed.token;
          try {
            response = await doFetch(activeToken);
          } catch (err) {
            const isTimeout = err instanceof Error && err.name === "TimeoutError";
            return {
              ok: false,
              message: isTimeout
                ? `BSC API retry timed out after ${BSC_CHECKLIST_FETCH_TIMEOUT_MS / 1000}s`
                : `BSC API retry failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }

        if (!response.ok) {
          return { ok: false, message: `BSC API error: ${response.status}` };
        }

        const data = await response.json();
        const results = Array.isArray(data) ? data : [];
        const raw: Record<string, unknown>[] = [];
        for (const r of results) {
          if (r && typeof r === "object") raw.push(r as Record<string, unknown>);
          if (raw.length >= MAX_CARDS) break;
        }
        console.log(
          `[fetchBscChecklist] variantName=${slug ?? "(none)"} returned=${results.length} kept=${raw.length}`,
        );
        if (results.length >= MAX_CARDS) {
          console.warn(
            `[fetchBscChecklist] hit MAX_CARDS=${MAX_CARDS} ceiling — set may be larger than expected.`,
          );
        }
        return { ok: true, raw };
      };

      const tagged: Array<{
        raw: Record<string, unknown>;
        queriedSlug?: string;
      }> = [];
      const failures: string[] = [];
      for (const slug of fanOut) {
        const res = await runOne(slug);
        if (!res.ok) {
          failures.push(`${slug ?? "(no variant)"}: ${res.message}`);
          continue;
        }
        for (const raw of res.raw) tagged.push({ raw, queriedSlug: slug });
      }

      // Fail the whole fetch if ANY request failed. A partial checklist is
      // worse than none: commit replaces the stored checklist, so silently
      // returning the slugs that happened to succeed would delete the cards
      // belonging to the one that didn't — and it would look like a clean run.
      if (failures.length > 0) {
        return {
          success: false,
          cards: [],
          message:
            failures.length === fanOut.length
              ? `BSC error: ${failures.join("; ")}`
              : `BSC returned only ${fanOut.length - failures.length} of ${fanOut.length} source sets — refusing a partial checklist: ${failures.join("; ")}`,
        };
      }

      console.log(
        `[fetchBscChecklist] ${fanOut.length} request(s) -> ${tagged.length} raw rows (bulk-upload catalog)`,
      );

      // Map raw → checklist card shape. Bulk-upload row keys are:
      //   id, setName, players (string), cardNo, playerAttribute,
      //   playerAttributeDesc, imgFront, imgBack, cardNoOrder,
      //   cardNoSequence, cardNoSort.
      // No year, sport, features, printRun, autograph, sportlots — those
      // don't exist on the catalog template. `team`/`teams` are populated
      // ONLY when `players` decodes to a Team Checklist card (parsePlayersField) —
      // the raw response itself never carries a separate team field.
      const seenRefs = new Set<string>();
      const cards = tagged
        .map(({ raw: r, queriedSlug }) => {
          const cardNumberRaw = r.cardNo ?? r.cardNumber ?? r.number;
          const cardNumber = typeof cardNumberRaw === "string" || typeof cardNumberRaw === "number"
            ? String(cardNumberRaw).trim()
            : "";
          if (!cardNumber) return null;

          // `players` is a single string in the bulk-upload response —
          // parse it for the team-checklist and multi-player-parenthetical
          // conventions (see parsePlayersField's own doc comment).
          const playersRaw = typeof r.players === "string" ? r.players : "";
          const { players, teams, namePrefix } = parsePlayersField(playersRaw);

          const attributes = parsePlayerAttributeTokens(r.playerAttribute);
          // NEO-189: only a genuine printing variety reaches `cardVariation`.
          // BSC reuses `playerAttributeDesc` for shelf notes and for "this is
          // the base card", neither of which belongs in the eBay
          // Parallel/Variety aspect this field feeds — see
          // `parseVariationDescription`.
          const parsedVariation = parseVariationDescription(r.playerAttributeDesc);
          const cardVariation = parsedVariation?.isVariety
            ? parsedVariation.text
            : undefined;

          const cardName = namePrefix
            ? `${namePrefix} (${players.join(" / ")})`
            : players.length
              ? players.join(" / ")
              : `Card #${cardNumber}`;

          const platformRefRaw = r.id;
          const platformRef = typeof platformRefRaw === "string" || typeof platformRefRaw === "number"
            ? String(platformRefRaw)
            : undefined;

          // Source attribution: prefer the slug WE queried. `r.setName` is the
          // parent set ("score" for a 1996 Score insert), which never matches a
          // slot on an insert row — so before the fan-out, per-card source
          // resolution silently found nothing and the BSC SOURCE chips could
          // not tell two attached sets apart. Fall back to r.setName for levels
          // with no variantName facet (Base), where it IS the row's own slug.
          const rawSetName = r.setName;
          const fallbackSlug =
            typeof rawSetName === "string" && rawSetName.trim()
              ? rawSetName.trim()
              : undefined;
          const sourceBscSetSlug = queriedSlug ?? fallbackSlug;

          return {
            cardNumber,
            cardName,
            team: undefined,
            teams: teams.length ? teams : undefined,
            players: players.length ? players : undefined,
            attributes: attributes.length ? attributes : undefined,
            printRun: undefined,
            autographType: undefined,
            cardVariation,
            platformRef,
            sportlotsRef: undefined,
            sourceBscSetSlug,
          };
        })
        .filter((c): c is NonNullable<typeof c> => c !== null)
        // Dedupe by BSC card id — overlapping source sets can legitimately
        // return the same card twice once several are mapped to one NB set.
        .filter((c) => {
          if (!c.platformRef) return true;
          if (seenRefs.has(c.platformRef)) return false;
          seenRefs.add(c.platformRef);
          return true;
        });

      return {
        success: true,
        cards,
        message: `Found ${cards.length} cards from BSC catalog`,
      };
    } catch (error) {
      console.error("[fetchBscChecklist] Error:", error);
      return {
        success: false,
        cards: [],
        message: `BSC error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

/**
 * NEO-90: call BSC's per-card detail endpoint and return its `teamName`.
 * `success: false` means the HTTP call itself failed (non-2xx or thrown
 * error) — distinct from `success: true, teamName: ""`, which means BSC
 * answered but genuinely has no team on file (an insert/subset card).
 * Callers that need retry semantics (resolveBscCardTeam) care about this
 * distinction; `fetchBscCardTeamNames` (the synchronous batch path) treats
 * both the same — it just won't populate a team either way. Shared by both.
 */
async function fetchBscCardTeamNameRaw(
  bscCardId: string,
): Promise<{ teamName: string; success: boolean }> {
  try {
    const response = await fetch(
      `${BSC_API_BASE}/marketplace/card/${bscCardId}/card-listing`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(BSC_TEAM_LOOKUP_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      console.warn(
        `[fetchBscCardTeamNameRaw] card-listing fetch failed status=${response.status} bscCardId=${bscCardId}`,
      );
      return { teamName: "", success: false };
    }
    const data = await response.json();
    const teamName =
      data && typeof data === "object" && typeof (data as { teamName?: unknown }).teamName === "string"
        ? (data as { teamName: string }).teamName.trim()
        : "";
    return { teamName, success: true };
  } catch (error) {
    console.warn(
      `[fetchBscCardTeamNameRaw] card-listing fetch error bscCardId=${bscCardId}:`,
      error,
    );
    return { teamName: "", success: false };
  }
}

/**
 * NEO-90: resolve a single card's team by calling BSC's per-card detail
 * endpoint. This is the async backfill/safety-net path — only ever called
 * from the throttled queue below (sets synced before NEO-90's synchronous
 * lookup existed, or a card whose synchronous lookup failed at fetch time).
 * A fresh sync resolves teams inline via `fetchBscCardTeamNames` instead
 * (see `fetchCardChecklist` in selectorOptions.ts). No-ops (leaves the row
 * untouched, so a future enqueue will retry) on any fetch/parse failure.
 */
export const resolveBscCardTeam = internalAction({
  args: { cardChecklistId: v.id("cardChecklist") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const row: { bscCardId: string; needsCheck: boolean } | null =
      await ctx.runQuery(internal.cardChecklist.getForBscTeamCheck, {
        cardChecklistId: args.cardChecklistId,
      });
    if (!row || !row.needsCheck) return null;

    const { teamName, success } = await fetchBscCardTeamNameRaw(row.bscCardId);
    // The fetch itself failed — leave the row untouched so a future
    // enqueue retries it (do NOT distinguish "no team" from "couldn't
    // check" here; only a successful call is allowed to mark this done).
    if (!success) return null;

    await ctx.runMutation(internal.cardChecklist.applyBscTeamResolution, {
      cardChecklistId: args.cardChecklistId,
      teamName,
    });
    return null;
  },
});

/**
 * NEO-90: resolve teams for a batch of BSC card ids concurrently, with a
 * bounded fan-out — called synchronously from `fetchCardChecklist` so team
 * names surface in the SAME confirm dialog as new players, instead of
 * trickling in via the background queue after save. Chunks into groups of
 * `BSC_TEAM_LOOKUP_CONCURRENCY` and awaits each chunk before starting the
 * next (matches the existing `MAX_SL_FAN_OUT` bounded-fan-out precedent in
 * selectorOptions.ts — no concurrency-limiting utility exists elsewhere in
 * this codebase to reuse). Returns only the ids that resolved to a
 * non-empty team name; a card whose lookup failed or had no team on file
 * (e.g. an insert/subset card) is simply absent from the result — the
 * caller treats that the same as "no team" either way.
 */
export const fetchBscCardTeamNames = internalAction({
  args: { bscCardIds: v.array(v.string()) },
  returns: v.record(v.string(), v.string()),
  handler: async (_ctx, args): Promise<Record<string, string>> => {
    const result: Record<string, string> = {};
    for (let i = 0; i < args.bscCardIds.length; i += BSC_TEAM_LOOKUP_CONCURRENCY) {
      const chunk = args.bscCardIds.slice(i, i + BSC_TEAM_LOOKUP_CONCURRENCY);
      const results = await Promise.all(
        chunk.map((bscCardId) => fetchBscCardTeamNameRaw(bscCardId)),
      );
      chunk.forEach((bscCardId, idx) => {
        const { teamName } = results[idx];
        if (teamName) result[bscCardId] = teamName;
      });
    }
    return result;
  },
});

/**
 * NEO-90: chained serial queue for BSC per-card team lookups — same shape
 * as adapters/wikidata.ts's processEnrichmentQueue. commitCardChecklist
 * hands the ids of newly-touched cards missing team data to this action
 * via `scheduler.runAfter(0, ...)`; it pops one id, resolves it, then
 * reschedules itself with the tail after BSC_TEAM_ENRICH_DELAY_MS. Errors
 * on a single card are caught/logged — the queue moves on rather than
 * abandoning the rest of the set.
 */
export const processBscTeamEnrichmentQueue = internalAction({
  args: { cardChecklistIds: v.array(v.id("cardChecklist")) },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const [head, ...tail] = args.cardChecklistIds;
    if (!head) {
      console.log(`[bsc-team-enrichment-queue] queue drained.`);
      return null;
    }

    try {
      await ctx.runAction(internal.adapters.buysportscards.resolveBscCardTeam, {
        cardChecklistId: head,
      });
    } catch (error) {
      console.error(`[bsc-team-enrichment-queue] resolveBscCardTeam ${head} failed:`, error);
    }

    if (tail.length > 0) {
      await ctx.scheduler.runAfter(
        BSC_TEAM_ENRICH_DELAY_MS,
        internal.adapters.buysportscards.processBscTeamEnrichmentQueue,
        { cardChecklistIds: tail },
      );
    }
    return null;
  },
});

// Keep the legacy getAvailableSetParameters for backward compatibility during migration
export const getAvailableSetParameters = action({
  args: {
    partialParams: v.optional(
      v.object({
        sport: v.optional(v.string()),
        year: v.optional(v.number()),
        manufacturer: v.optional(v.string()),
        setName: v.optional(v.string()),
        variantType: v.optional(
          v.union(
            v.literal("base"),
            v.literal("parallel"),
            v.literal("insert"),
            v.literal("parallel_of_insert"),
          ),
        ),
      }),
    ),
  },
  returns: v.object({
    availableOptions: v.object({
      sports: v.optional(
        v.array(
          v.object({
            site: v.string(),
            values: v.array(
              v.object({ label: v.string(), value: v.string() }),
            ),
          }),
        ),
      ),
      years: v.optional(
        v.array(
          v.object({
            site: v.string(),
            values: v.array(
              v.object({ label: v.string(), value: v.string() }),
            ),
          }),
        ),
      ),
      manufacturers: v.optional(
        v.array(
          v.object({
            site: v.string(),
            values: v.array(
              v.object({ label: v.string(), value: v.string() }),
            ),
          }),
        ),
      ),
      setNames: v.optional(
        v.array(
          v.object({
            site: v.string(),
            values: v.array(
              v.object({ label: v.string(), value: v.string() }),
            ),
          }),
        ),
      ),
      variantNames: v.optional(
        v.array(
          v.object({
            site: v.string(),
            values: v.array(
              v.object({ label: v.string(), value: v.string() }),
            ),
          }),
        ),
      ),
    }),
    currentParams: v.optional(
      v.object({
        sport: v.optional(v.string()),
        year: v.optional(v.number()),
        manufacturer: v.optional(v.string()),
        setName: v.optional(v.string()),
        variantType: v.optional(
          v.union(
            v.literal("base"),
            v.literal("parallel"),
            v.literal("insert"),
            v.literal("parallel_of_insert"),
          ),
        ),
      }),
    ),
  }),
  handler: async (ctx, args): Promise<any> => {
    await requireAdmin(ctx);
    // Delegate to the new fetchBscSelectorOptions for actual data
    // This wrapper maintains backward compatibility
    const parentFilters: Record<string, string> = {};
    if (args.partialParams?.sport)
      parentFilters.sport = args.partialParams.sport;
    if (args.partialParams?.year)
      parentFilters.year = String(args.partialParams.year);
    if (args.partialParams?.manufacturer)
      parentFilters.manufacturer = args.partialParams.manufacturer;
    if (args.partialParams?.setName)
      parentFilters.setName = args.partialParams.setName;
    if (args.partialParams?.variantType)
      parentFilters.variantType = args.partialParams.variantType;

    // Determine which level to fetch
    let level = "sport";
    if (args.partialParams?.sport && !args.partialParams?.year)
      level = "year";
    else if (args.partialParams?.year && !args.partialParams?.manufacturer)
      level = "manufacturer";
    else if (
      args.partialParams?.manufacturer &&
      !args.partialParams?.setName
    )
      level = "setName";
    else if (
      args.partialParams?.setName &&
      !args.partialParams?.variantType
    )
      level = "variantType";

    const result: { success: boolean; options: Array<{ value: string; platformValue: string }>; message?: string } = await ctx.runAction(
      api.adapters.buysportscards.fetchBscSelectorOptions,
      {
        level,
        parentFilters: {
          sport: parentFilters.sport,
          year: parentFilters.year,
          manufacturer: parentFilters.manufacturer,
          setName: parentFilters.setName,
          variantType: parentFilters.variantType,
        },
      },
    );

    // Convert to legacy format
    const availableOptions: Record<string, unknown> = {};
    const levelToKey: Record<string, string> = {
      sport: "sports",
      year: "years",
      manufacturer: "manufacturers",
      setName: "setNames",
      variantType: "variantNames",
    };

    const key = levelToKey[level];
    if (key && result.options.length > 0) {
      availableOptions[key] = [
        {
          site: "BSC",
          values: result.options.map((o: { value: string; platformValue: string }) => ({
            label: o.value,
            value: o.platformValue,
          })),
        },
      ];
    }

    return {
      availableOptions: availableOptions as any,
      currentParams: args.partialParams,
    };
  },
});
