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
 * Pull a card-variation description out of BSC's `playerAttributeDesc`
 * field. Bulk-upload stores variation text here prefixed with markers
 * like "VAR:", "SSP:", etc. — strip the leading marker so the residual
 * is a clean human-readable string. Returns undefined when empty.
 */
function parseVariationDescription(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^[A-Z]{2,4}:\s*/, "").trim() || undefined;
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

      // Single call — confirmed live: BSC's /search/bulk-upload/results
      // ignores `size`/`page` and returns the full filtered result set
      // in one response. No pagination loop. We pass `size` as a defense
      // anyway in case behavior changes upstream.
      //
      // Hard cap at 5000 cards to stay well under Convex's 8192 array
      // length limit on action return values. Most sets are ≤1000; the
      // largest mainstream sets (e.g. Bowman Chrome) are ~600 cards. A
      // 5000-card response would be surprising and worth investigating.
      const MAX_CARDS = 5000;
      const body = {
        condition: "all",
        page: 0,
        size: MAX_CARDS,
        sort: "default",
        filters,
      };
      // Wrapped so we can retry once with a fresh token on 401. BSC's API
      // can intermittently 401 with a token our cache still thinks is fresh
      // (BSC's token TTL doesn't always match what they advertise, especially
      // under load). Rather than failing the whole fetch, refresh and retry.
      const doFetch = async (token: string): Promise<Response> => {
        return await fetch(`${BSC_API_BASE}/search/bulk-upload/results`, {
          method: "POST",
          headers: bscHeaders(token),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(BSC_CHECKLIST_FETCH_TIMEOUT_MS),
        });
      };

      let response: Response;
      let activeToken = tokenResult.token;
      try {
        response = await doFetch(activeToken);
      } catch (err) {
        const isTimeout = err instanceof Error && err.name === "TimeoutError";
        const msg = isTimeout
          ? `BSC API request timed out after ${BSC_CHECKLIST_FETCH_TIMEOUT_MS / 1000}s`
          : `BSC API request failed: ${err instanceof Error ? err.message : String(err)}`;
        return { success: false, cards: [], message: msg };
      }

      if (response.status === 401) {
        console.warn(
          `[fetchBscChecklist] BSC API 401 with cached token — forcing re-auth and retrying once`,
        );
        // Drain the failed response body to free the socket before retrying.
        await response.text().catch(() => "");
        const reAuth = (await ctx.runAction(internal.credentials.authenticateBsc, {})) as {
          success: boolean;
          message?: string;
        };
        if (!reAuth.success) {
          console.error(
            `[fetchBscChecklist] re-auth failed after 401: ${reAuth.message ?? "(no message)"}`,
          );
          return {
            success: false,
            cards: [],
            message: `BSC API 401 and re-auth failed`,
          };
        }
        const refreshedToken: { success: boolean; token?: string; error?: string } =
          await ctx.runAction(internal.adapters.buysportscards.getBscToken, {});
        if (!refreshedToken.success || !refreshedToken.token) {
          return {
            success: false,
            cards: [],
            message: refreshedToken.error || "No BSC token available after re-auth",
          };
        }
        activeToken = refreshedToken.token;
        try {
          response = await doFetch(activeToken);
        } catch (err) {
          const isTimeout = err instanceof Error && err.name === "TimeoutError";
          const msg = isTimeout
            ? `BSC API retry timed out after ${BSC_CHECKLIST_FETCH_TIMEOUT_MS / 1000}s`
            : `BSC API retry failed: ${err instanceof Error ? err.message : String(err)}`;
          return { success: false, cards: [], message: msg };
        }
      }

      if (!response.ok) {
        return {
          success: false,
          cards: [],
          message: `BSC API error: ${response.status}`,
        };
      }

      const data = await response.json();
      const results = Array.isArray(data) ? data : [];
      const rawCards: Record<string, unknown>[] = [];
      for (const r of results) {
        if (r && typeof r === "object") rawCards.push(r as Record<string, unknown>);
        if (rawCards.length >= MAX_CARDS) break;
      }

      console.log(
        `[fetchBscChecklist] returned=${results.length} kept=${rawCards.length} (bulk-upload catalog)`,
      );
      if (results.length >= MAX_CARDS) {
        console.warn(
          `[fetchBscChecklist] hit MAX_CARDS=${MAX_CARDS} ceiling — set may be larger than expected.`,
        );
      }

      // Map raw → checklist card shape. Bulk-upload row keys are:
      //   id, setName, players (string), cardNo, playerAttribute,
      //   playerAttributeDesc, imgFront, imgBack, cardNoOrder,
      //   cardNoSequence, cardNoSort.
      // No year, sport, features, printRun, autograph, sportlots — those
      // don't exist on the catalog template. `team`/`teams` are populated
      // ONLY when `players` decodes to a Team Checklist card (parsePlayersField) —
      // the raw response itself never carries a separate team field.
      const cards = rawCards
        .map((r) => {
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
          const cardVariation = parseVariationDescription(r.playerAttributeDesc);

          const cardName = namePrefix
            ? `${namePrefix} (${players.join(" / ")})`
            : players.length
              ? players.join(" / ")
              : `Card #${cardNumber}`;

          const platformRefRaw = r.id;
          const platformRef = typeof platformRefRaw === "string" || typeof platformRefRaw === "number"
            ? String(platformRefRaw)
            : undefined;

          // NEO-6: BSC's bulk-upload row carries the source set slug per
          // card. When the variant has multiple BSC IDs attached (single
          // call returns the union), this is how we tell them apart.
          const sourceBscSetSlugRaw = r.setName;
          const sourceBscSetSlug =
            typeof sourceBscSetSlugRaw === "string" && sourceBscSetSlugRaw.trim()
              ? sourceBscSetSlugRaw.trim()
              : undefined;

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
        .filter((c): c is NonNullable<typeof c> => c !== null);

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
