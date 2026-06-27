"use node";

import { action, ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { api, internal } from "../_generated/api";
import { getCurrentUserId, requireAdmin } from "../auth";
import { Id } from "../_generated/dataModel";
import {
  recordAdapterCall,
  newRequestId,
  classifyAdapterError,
} from "../observability";

type Level = "sport" | "year" | "manufacturer" | "setName" | "variantType" | "insert" | "parallel";

const SPORTLOTS_BASE_URL = "https://www.sportlots.com";
const NEWINVEN_URL = `${SPORTLOTS_BASE_URL}/inven/dealbin/newinven.tpl`;
const DEALSETS_URL = `${SPORTLOTS_BASE_URL}/inven/dealbin/dealsets.tpl`;
const LISTCARDS_URL = `${SPORTLOTS_BASE_URL}/inven/dealbin/listcards.tpl`;

const SL_FETCH_TIMEOUT_MS = 30_000;

// Selector-option columns (sport / year / manufacturer) load on every drill and
// must feel instant — SL answers the newinven dropdown query in ~1s. A slow or
// hung SL response must NOT ride out the full 30s SL_FETCH_TIMEOUT_MS and freeze
// the column. So the selector fetch uses a tight per-attempt budget and retries
// a few times (logging each miss) before surfacing a fetch error. Heavier calls
// (card checklists, set lists) keep the 30s default.
const SL_SELECTOR_FETCH_TIMEOUT_MS = 3_000;
const SL_SELECTOR_FETCH_MAX_ATTEMPTS = 3;

async function slFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number = SL_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        `SportLots request timed out after ${timeoutMs / 1000}s: ${url}`,
      );
    }
    throw err;
  }
}

// Fetch a selector-options page with a short per-attempt timeout and bounded
// retries. SL occasionally stalls on these dropdown queries; rather than block
// the column for 30s we abort at SL_SELECTOR_FETCH_TIMEOUT_MS, log what
// happened, and retry. Throws the last error if every attempt fails so the
// aggregator records a real fetch error (and the column can offer Retry).
async function slSelectorFetchWithRetry(
  url: string,
  init: RequestInit,
  meta: { requestId: string; level: string },
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= SL_SELECTOR_FETCH_MAX_ATTEMPTS; attempt++) {
    try {
      return await slFetch(url, init, SL_SELECTOR_FETCH_TIMEOUT_MS);
    } catch (err) {
      lastErr = err;
      console.warn(
        JSON.stringify({
          msg: "sl_selector_fetch_retry",
          requestId: meta.requestId,
          level: meta.level,
          attempt,
          maxAttempts: SL_SELECTOR_FETCH_MAX_ATTEMPTS,
          timeoutMs: SL_SELECTOR_FETCH_TIMEOUT_MS,
          url,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("SportLots selector fetch failed after retries");
}

// Map selector levels to SportLots form field names
const LEVEL_TO_TARGET_SELECT: Record<string, string> = {
  sport: "sprt",
  year: "yr",
  manufacturer: "brd",
};

/**
 * Get stored SportLots session cookie from credentials.
 * Same pattern as getBscToken in buysportscards.ts.
 */
async function getSportLotsCookie(ctx: ActionCtx): Promise<string | null> {
  const tokenResult = await ctx.runAction(
    internal.credentials.getSiteToken,
    { site: "sportlots" },
  );
  return tokenResult?.token || null;
}

/**
 * Check if a response body indicates a stale/expired session.
 */
function isSessionExpired(html: string): boolean {
  return html.includes("login.tpl") || html.includes("signin.tpl");
}

/**
 * Parse <option> elements from an HTML <select> element.
 * SportLots uses unclosed option tags: <Option value="BB">Baseball
 */
function parseSelectOptions(
  html: string,
  selectName: string,
): Array<{ value: string; label: string }> {
  const selectRegex = new RegExp(
    `<select[^>]*name="${selectName}"[^>]*>([\\s\\S]*?)<\\/select>`,
    "i",
  );
  const selectMatch = html.match(selectRegex);

  if (!selectMatch) {
    console.log(
      `[parseSelectOptions] No select element found for name="${selectName}"`,
    );
    return [];
  }

  const selectContent = selectMatch[1];

  // Fixed regex: SportLots uses unclosed <Option> tags, capture label up to newline or next tag
  const optionRegex = /<Option\s+value="([^"]*)"[^>]*>\s*([^\n<]+)/gi;
  const options: Array<{ value: string; label: string }> = [];
  let match;

  while ((match = optionRegex.exec(selectContent)) !== null) {
    const value = match[1].trim();
    const label = match[2].trim();

    if (value && label && value !== "" && label !== "Select") {
      options.push({ value, label });
    }
  }

  return options;
}

/**
 * Resolve a display value (e.g., "Baseball") to a SportLots platform value (e.g., "BB")
 * by looking up the selectorOptions table.
 */
async function resolveSportLotsPlatformValue(
  ctx: ActionCtx,
  level: Level,
  displayValue: string,
  parentId?: Id<"selectorOptions">,
): Promise<string> {
  try {
    const option: any = await ctx.runQuery(
      api.selectorOptions.findByLevelAndValue,
      { level, value: displayValue, parentId },
    );
    return option?.platformData?.sportlots || displayValue;
  } catch {
    return displayValue;
  }
}

/**
 * Fetch selector options from SportLots via HTTP
 */
export const fetchSportLotsSelectorOptions = action({
  args: {
    level: v.string(),
    parentFilters: v.object({
      sport: v.optional(v.string()),
      year: v.optional(v.string()),
      manufacturer: v.optional(v.string()),
      setName: v.optional(v.string()),
      variantType: v.optional(v.string()),
    }),
    // Pre-resolved SportLots platform values keyed by level (e.g., { sport: "BB", year: "2024" }).
    // When provided, these are used directly instead of resolving via DB lookup.
    platformFilters: v.optional(v.record(v.string(), v.string())),
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
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    const requestId = args.requestId ?? newRequestId();
    const start = Date.now();
    let tokenMs: number | undefined;
    let filtersCallMs: number | undefined;
    let statusCode: number | undefined;
    try {
      const tokenStart = Date.now();
      let sessionCookie = await getSportLotsCookie(ctx);
      tokenMs = Date.now() - tokenStart;
      if (!sessionCookie) {
        await recordAdapterCall(ctx, {
          requestId,
          operation: "fetchSportLotsSelectorOptions",
          platform: "sportlots",
          level: args.level,
          parentSport: args.parentFilters.sport,
          parentYear: args.parentFilters.year,
          parentSetName: args.parentFilters.setName,
          duration_ms: Date.now() - start,
          token_ms: tokenMs,
          success: false,
          stage: "auth",
          error_class: "no_credentials",
        });
        return {
          success: false,
          options: [],
          message: "No SportLots session cookie. Re-authenticate from Profile.",
        };
      }

      // setName and variantType: BSC-only levels in NB's hierarchy.
      // SL doesn't have separate set or variant-type concepts.
      if (args.level === "setName" || args.level === "variantType") {
        await recordAdapterCall(ctx, {
          requestId,
          operation: "fetchSportLotsSelectorOptions",
          platform: "sportlots",
          level: args.level,
          parentSport: args.parentFilters.sport,
          parentYear: args.parentFilters.year,
          parentSetName: args.parentFilters.setName,
          duration_ms: Date.now() - start,
          token_ms: tokenMs,
          success: true,
          result_count: 0,
          stage: "adapter",
          error_class: "unsupported_level",
        });
        return { success: true, options: [] };
      }

      // insert level (NB "Variant"): SL's dealsets.tpl set list maps here.
      // SL combines set+variant into a flat list of set names.
      if (args.level === "insert") {
        const insertResult = await fetchSetNames(ctx, sessionCookie, args.parentFilters, args.platformFilters);
        await recordAdapterCall(ctx, {
          requestId,
          operation: "fetchSportLotsSelectorOptions",
          platform: "sportlots",
          level: args.level,
          parentSport: args.parentFilters.sport,
          parentYear: args.parentFilters.year,
          parentSetName: args.parentFilters.setName,
          duration_ms: Date.now() - start,
          token_ms: tokenMs,
          success: insertResult.success,
          result_count: insertResult.options.length,
          stage: "marketplace_fetch",
          error_class: insertResult.success
            ? undefined
            : classifyAdapterError(insertResult.message),
        });
        return insertResult;
      }

      // sport, year, manufacturer: POST to newinven.tpl and parse select options
      const formData = new URLSearchParams();

      // Use pre-resolved platform slugs when available, otherwise fall back to DB lookup
      if (args.parentFilters.sport) {
        const platformSport = args.platformFilters?.sport
          ?? await resolveSportLotsPlatformValue(ctx, "sport", args.parentFilters.sport);
        formData.set("sprt", platformSport);
      }
      if (args.parentFilters.year) {
        const platformYear = args.platformFilters?.year
          ?? await resolveSportLotsPlatformValue(ctx, "year", args.parentFilters.year);
        formData.set("yr", platformYear);
      }
      if (args.parentFilters.manufacturer) {
        const platformBrand = args.platformFilters?.manufacturer
          ?? await resolveSportLotsPlatformValue(ctx, "manufacturer", args.parentFilters.manufacturer);
        formData.set("brd", platformBrand);
      }

      const filtersStart = Date.now();
      const response = await slSelectorFetchWithRetry(
        NEWINVEN_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: sessionCookie,
          },
          body: formData.toString(),
        },
        { requestId, level: args.level },
      );
      filtersCallMs = Date.now() - filtersStart;
      statusCode = response.status;

      if (!response.ok) {
        await recordAdapterCall(ctx, {
          requestId,
          operation: "fetchSportLotsSelectorOptions",
          platform: "sportlots",
          level: args.level,
          parentSport: args.parentFilters.sport,
          parentYear: args.parentFilters.year,
          parentSetName: args.parentFilters.setName,
          duration_ms: Date.now() - start,
          token_ms: tokenMs,
          filters_call_ms: filtersCallMs,
          status_code: statusCode,
          success: false,
          stage: "marketplace_fetch",
          error_class: classifyAdapterError(
            `SportLots HTTP ${response.status}`,
          ),
        });
        return {
          success: false,
          options: [],
          message: `SportLots HTTP error: ${response.status}`,
        };
      }

      const html = await response.text();

      // A session rejection here is SL's tiny login.tpl redirect stub (it has
      // NO <select>), so it parses to 0 options below and is recovered by the
      // re-auth retry loop. We deliberately do NOT bail with a dead "session
      // expired" error: with a valid session SL reliably returns the options,
      // so an empty/stub response means the (shared) session cookie was
      // invalidated and we re-authenticate + retry — the recovery the
      // getSiteToken architecture intends but only performs on expiresAt.

      const targetSelect = LEVEL_TO_TARGET_SELECT[args.level];
      if (!targetSelect) {
        await recordAdapterCall(ctx, {
          requestId,
          operation: "fetchSportLotsSelectorOptions",
          platform: "sportlots",
          level: args.level,
          parentSport: args.parentFilters.sport,
          parentYear: args.parentFilters.year,
          parentSetName: args.parentFilters.setName,
          duration_ms: Date.now() - start,
          token_ms: tokenMs,
          filters_call_ms: filtersCallMs,
          status_code: statusCode,
          success: false,
          stage: "adapter",
          error_class: "unsupported_level",
        });
        return {
          success: false,
          options: [],
          message: `Unknown level: ${args.level}`,
        };
      }

      let parsedOptions = parseSelectOptions(html, targetSelect);

      // 0 parsed options means SL returned a session-rejection / login.tpl stub
      // (no <select>) — with a valid session these levels are ALWAYS populated
      // (confirmed: SL reliably returns the full option list for a valid
      // cookie). The shared dev SL session gets invalidated intermittently and
      // the cached token's expiresAt still reads fresh, so re-POSTing the same
      // cookie can't recover. Force a re-auth (fresh session), refresh the
      // cookie, and retry. Each attempt logs what SL returned (params, status,
      // which <select>s were present) for diagnosis — never the cookie.
      let lastHtml = html;
      let selectorAttempt = 1;
      while (
        parsedOptions.length === 0 &&
        selectorAttempt < SL_SELECTOR_FETCH_MAX_ATTEMPTS
      ) {
        console.warn(
          JSON.stringify({
            msg: "sl_selector_empty_result",
            requestId,
            level: args.level,
            attempt: selectorAttempt,
            maxAttempts: SL_SELECTOR_FETCH_MAX_ATTEMPTS,
            sprt: formData.get("sprt"),
            yr: formData.get("yr"),
            targetSelect,
            status: statusCode,
            htmlLen: lastHtml.length,
            targetSelectPresent: new RegExp(
              `<select[^>]*name=["']?${targetSelect}\\b`,
              "i",
            ).test(lastHtml),
            presentSelects: [
              ...lastHtml.matchAll(/<select[^>]*\bname=["']?([^"'\s>]+)/gi),
            ]
              .map((m) => m[1])
              .slice(0, 25),
          }),
        );
        selectorAttempt++;
        // Re-authenticate to recover a fresh shared SL session, then refresh
        // the cookie — re-POSTing the same invalidated cookie can't help.
        await ctx
          .runAction(internal.credentials.authenticateSportlots, {})
          .catch(() => {});
        sessionCookie = (await getSportLotsCookie(ctx)) ?? sessionCookie;
        // Brief backoff so the fresh session settles before the re-POST.
        await new Promise((resolve) => setTimeout(resolve, 500));
        try {
          const retryResp = await slFetch(
            NEWINVEN_URL,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                Cookie: sessionCookie,
              },
              body: formData.toString(),
            },
            SL_SELECTOR_FETCH_TIMEOUT_MS,
          );
          statusCode = retryResp.status;
          if (!retryResp.ok) break;
          const retryHtml = await retryResp.text();
          lastHtml = retryHtml;
          parsedOptions = parseSelectOptions(retryHtml, targetSelect);
        } catch (err) {
          console.warn(
            JSON.stringify({
              msg: "sl_selector_fetch_retry",
              requestId,
              level: args.level,
              attempt: selectorAttempt,
              reason: "empty_result_retry_fetch_error",
              error: err instanceof Error ? err.message : String(err),
            }),
          );
        }
      }

      // Still empty after retries — emit a queryable PostHog event capturing
      // what SL actually returned, so the root cause can be diagnosed directly.
      if (parsedOptions.length === 0) {
        await ctx
          .runAction(internal.posthog.captureEvent, {
            distinctId: "sl-adapter-debug",
            event: "selector_sync_empty",
            properties: {
              level: args.level,
              requestId,
              sprt: formData.get("sprt"),
              yr: formData.get("yr"),
              targetSelect,
              status_code: statusCode,
              html_len: lastHtml.length,
              target_select_present: new RegExp(
                `<select[^>]*name=["']?${targetSelect}\\b`,
                "i",
              ).test(lastHtml),
              present_selects: [
                ...lastHtml.matchAll(/<select[^>]*\bname=["']?([^"'\s>]+)/gi),
              ]
                .map((m) => m[1])
                .slice(0, 25),
              attempts: selectorAttempt,
            },
          })
          .catch(() => {});
      }

      // Exhausted re-auth retries and SL is still returning the session-reject
      // stub — surface a clear, actionable error instead of a silently empty
      // column. (With a healthy session this branch is never reached.)
      if (parsedOptions.length === 0 && isSessionExpired(lastHtml)) {
        await recordAdapterCall(ctx, {
          requestId,
          operation: "fetchSportLotsSelectorOptions",
          platform: "sportlots",
          level: args.level,
          parentSport: args.parentFilters.sport,
          parentYear: args.parentFilters.year,
          parentSetName: args.parentFilters.setName,
          duration_ms: Date.now() - start,
          token_ms: tokenMs,
          filters_call_ms: filtersCallMs,
          status_code: statusCode,
          success: false,
          stage: "marketplace_fetch",
          error_class: "session_expired",
        });
        return {
          success: false,
          options: [],
          message: "SportLots session expired. Re-authenticate from Profile.",
        };
      }

      await recordAdapterCall(ctx, {
        requestId,
        operation: "fetchSportLotsSelectorOptions",
        platform: "sportlots",
        level: args.level,
        parentSport: args.parentFilters.sport,
        parentYear: args.parentFilters.year,
        parentSetName: args.parentFilters.setName,
        duration_ms: Date.now() - start,
        token_ms: tokenMs,
        filters_call_ms: filtersCallMs,
        status_code: statusCode,
        success: parsedOptions.length > 0,
        result_count: parsedOptions.length,
        stage: "marketplace_fetch",
      });

      return {
        success: true,
        options: parsedOptions.map((o) => ({
          value: o.label,
          platformValue: o.value,
        })),
      };
    } catch (error) {
      console.error("[fetchSportLotsSelectorOptions] Error:", error);
      await recordAdapterCall(ctx, {
        requestId,
        operation: "fetchSportLotsSelectorOptions",
        platform: "sportlots",
        level: args.level,
        parentSport: args.parentFilters.sport,
        parentYear: args.parentFilters.year,
        parentSetName: args.parentFilters.setName,
        duration_ms: Date.now() - start,
        token_ms: tokenMs,
        filters_call_ms: filtersCallMs,
        status_code: statusCode,
        success: false,
        stage: "marketplace_fetch",
        error_class: classifyAdapterError(
          error instanceof Error ? error.message : String(error),
        ),
      });
      return {
        success: false,
        options: [],
        message: `SportLots error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

/**
 * Fetch set names from SportLots using the dealsets.tpl multi-page flow.
 * 1. POST to newinven.tpl with sport/year/brand + required fields
 * 2. POST to dealsets.tpl — returns radio buttons for sets
 * 3. Parse radio buttons and return set name + radio ID
 */
async function fetchSetNames(
  ctx: ActionCtx,
  sessionCookie: string,
  parentFilters: {
    sport?: string;
    year?: string;
    manufacturer?: string;
  },
  platformFilters?: Record<string, string>,
): Promise<{ success: boolean; options: Array<{ value: string; platformValue: string }>; message?: string }> {
  // Use pre-resolved platform slugs when available, otherwise fall back to DB lookup
  let platformSport = "";
  let platformYear = "";
  let platformBrand = "";

  if (parentFilters.sport) {
    platformSport = platformFilters?.sport
      ?? await resolveSportLotsPlatformValue(ctx, "sport", parentFilters.sport);
  }
  if (parentFilters.year) {
    platformYear = platformFilters?.year
      ?? await resolveSportLotsPlatformValue(ctx, "year", parentFilters.year);
  }
  if (parentFilters.manufacturer) {
    platformBrand = platformFilters?.manufacturer
      ?? await resolveSportLotsPlatformValue(ctx, "manufacturer", parentFilters.manufacturer);
  }

  const commonFields: Record<string, string> = {
    sprt: platformSport,
    yr: platformYear,
    brd: platformBrand,
    dcond: "NM",
    dbin: "1",
    dval: "0.18",
    dentry: "ADD",
    pricing: "OLD",
  };

  // POST to dealsets.tpl to get set radio buttons
  const formData = new URLSearchParams(commonFields);
  const response = await slFetch(DEALSETS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: sessionCookie,
    },
    body: formData.toString(),
  });

  if (!response.ok) {
    return {
      success: false,
      options: [],
      message: `SportLots dealsets HTTP error: ${response.status}`,
    };
  }

  const html = await response.text();

  if (isSessionExpired(html)) {
    return {
      success: false,
      options: [],
      message: "SportLots session expired. Re-authenticate from Profile.",
    };
  }

  // Parse radio buttons: <input type="radio" Name="selset" Value="12345"> </td> <td>123  Set Name Here</td>
  const radioRegex = /<input\s+type="radio"\s+Name="selset"\s+Value="(\d+)"[^>]*>\s*<\/td>\s*<td>\d+\s+([^<]+)<\/td>/gi;
  const options: Array<{ value: string; platformValue: string }> = [];
  let match;

  while ((match = radioRegex.exec(html)) !== null) {
    const radioId = match[1].trim();
    let setName = match[2].trim();

    // Strip brand prefix from set name if present
    if (parentFilters.manufacturer) {
      const brandPrefix = parentFilters.manufacturer.trim();
      if (setName.startsWith(brandPrefix)) {
        setName = setName.substring(brandPrefix.length).trim();
      }
    }

    if (radioId && setName) {
      options.push({ value: setName, platformValue: radioId });
    }
  }

  return {
    success: true,
    options,
    message: `Found ${options.length} sets from SportLots`,
  };
}

/**
 * Tokenize a SportLots card description for known attribute markers.
 * Returns the tokens to lift onto attributes[], the printRun if present,
 * and the residual text (description with markers stripped) for use as
 * cardName.
 *
 * SL descriptions are free-form ("Mike Trout LAA RC", "Aaron Judge AU /99");
 * we conservatively detect only well-known tokens to avoid corrupting
 * cardName with false positives. Team extraction is intentionally NOT
 * attempted here — SL's 2-3 letter team abbreviations vary by sport and
 * BSC supplies the canonical team in the merged record anyway.
 */
function tokenizeSlDescription(desc: string): {
  attributes: string[];
  printRun?: number;
  residual: string;
} {
  const attributes: string[] = [];
  let printRun: number | undefined;
  let residual = desc;

  // /N print run pattern (e.g. "/99", "/150"). Strip from residual.
  const numMatch = residual.match(/\/(\d{1,5})\b/);
  if (numMatch) {
    const n = Number(numMatch[1]);
    if (Number.isFinite(n)) {
      printRun = n;
      attributes.push("NUM");
    }
    residual = residual.replace(numMatch[0], "");
  }

  // Token pattern: case-insensitive whole-word match on known markers.
  // Order matters — match longer tokens first to avoid AU shadowing AUTO.
  const tokenMap: Array<[RegExp, string]> = [
    [/\bAUTO\b/i, "AU"],
    [/\bAU\b/i, "AU"],
    [/\bROOKIE\b/i, "RC"],
    [/\bRC\b/i, "RC"],
    [/\bRELIC\b/i, "RELIC"],
    [/\bPATCH\b/i, "RELIC"],
    [/\bJSY\b/i, "RELIC"],
    [/\bJERSEY\b/i, "RELIC"],
    [/\bSP\b/i, "SP"],
    [/\bSSP\b/i, "SSP"],
  ];
  for (const [pattern, token] of tokenMap) {
    if (pattern.test(residual)) {
      if (!attributes.includes(token)) attributes.push(token);
      residual = residual.replace(pattern, "");
    }
  }

  residual = residual.replace(/\s+/g, " ").trim();
  return { attributes, printRun, residual };
}

/**
 * Fetch card checklist from SportLots for a specific set.
 *
 * Returns rows in the same shape as fetchBscChecklist (most rich fields
 * left empty since SL's HTML doesn't expose structured per-card metadata).
 * The reconciler in fetchCardChecklist merges a SL row's attributes into
 * the BSC row when card numbers match — so even sparse SL data still
 * cross-validates the BSC scrape.
 */
export const fetchSportLotsChecklist = action({
  args: {
    parentFilters: v.record(v.string(), v.string()),
    // Pre-resolved SportLots platform values keyed by level.
    platformFilters: v.optional(v.record(v.string(), v.string())),
  },
  returns: v.object({
    success: v.boolean(),
    cards: v.array(
      v.object({
        cardNumber: v.string(),
        cardName: v.string(),
        team: v.optional(v.string()),
        teams: v.optional(v.array(v.string())),
        players: v.optional(v.array(v.string())),
        attributes: v.optional(v.array(v.string())),
        printRun: v.optional(v.number()),
        autographType: v.optional(v.string()),
        cardVariation: v.optional(v.string()),
        platformRef: v.optional(v.string()),
        sportlotsRef: v.optional(v.string()),
      }),
    ),
    message: v.optional(v.string()),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    try {
      const sessionCookie = await getSportLotsCookie(ctx);
      if (!sessionCookie) {
        return {
          success: false,
          cards: [],
          message: "No SportLots session cookie. Re-authenticate from Profile.",
        };
      }

      // Look up the set's platformData.sportlots (the radio button ID)
      let setRadioId = args.platformFilters?.setName || args.parentFilters.setName || "";

      // Fall back to DB lookup if we don't have a pre-resolved platform value
      if (!args.platformFilters?.setName && args.parentFilters.setName) {
        const platformValue = await resolveSportLotsPlatformValue(
          ctx, "setName", args.parentFilters.setName,
        );
        if (platformValue !== args.parentFilters.setName) {
          setRadioId = platformValue;
        }
      }

      if (!setRadioId) {
        return {
          success: false,
          cards: [],
          message: "No set identifier available for SportLots",
        };
      }

      // POST to listcards.tpl with the set radio ID
      const formData = new URLSearchParams({
        selset: setRadioId,
        dcond: "NM",
        dbin: "1",
        dval: "0.18",
        dentry: "ADD",
        pricing: "OLD",
        start: "1",
      });

      const response = await slFetch(LISTCARDS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: sessionCookie,
        },
        body: formData.toString(),
      });

      if (!response.ok) {
        return {
          success: false,
          cards: [],
          message: `SportLots HTTP error: ${response.status}`,
        };
      }

      const html = await response.text();

      if (isSessionExpired(html)) {
        return {
          success: false,
          cards: [],
          message: "SportLots session expired. Re-authenticate from Profile.",
        };
      }

      // Parse card table rows
      // Pattern: <td class="smallleft">CARD_NUMBER</td> ... <td class="smallleft">DESCRIPTION</td>
      const cardRegex = /<td class="smallleft">([^<]+)<\/td>\s*<td class="smallleft">([^<]+)<\/td>/gi;
      const cards: Array<{
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
      }> = [];
      let match;

      while ((match = cardRegex.exec(html)) !== null) {
        const cardNumber = match[1].trim();
        const fullDescription = match[2].trim();

        if (!cardNumber || !fullDescription) continue;

        // Strip a leading "#NNN" if the description echoes the card number,
        // then run the token tokenizer to lift attributes / print run.
        let working = fullDescription;
        const echo = working.indexOf(`#${cardNumber}`);
        if (echo !== -1) {
          working = working.substring(echo + cardNumber.length + 1).trim();
        }

        const { attributes, printRun, residual } = tokenizeSlDescription(working);
        const cardName = residual || fullDescription;

        cards.push({
          cardNumber,
          cardName,
          attributes: attributes.length ? attributes : undefined,
          printRun,
          autographType: attributes.includes("AU") ? "Unknown" : undefined,
          platformRef: cardNumber,
          sportlotsRef: cardNumber,
        });
      }

      return {
        success: true,
        cards,
        message: `Found ${cards.length} cards from SportLots`,
      };
    } catch (error) {
      console.error("[fetchSportLotsChecklist] Error:", error);
      return {
        success: false,
        cards: [],
        message: `SportLots error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});

/**
 * Test SportLots credentials by checking stored cookie validity.
 */
export const testCredentials = action({
  args: {},
  returns: v.object({
    success: v.boolean(),
    message: v.string(),
    details: v.optional(v.string()),
  }),
  handler: async (
    ctx,
  ): Promise<{ success: boolean; message: string; details?: string }> => {
    const userId = await getCurrentUserId(ctx);
    if (!userId) {
      return {
        success: false,
        message: "Not authenticated",
        details: "Please sign in to test credentials",
      };
    }

    const sessionCookie = await getSportLotsCookie(ctx);

    if (!sessionCookie) {
      return {
        success: false,
        message: "No SportLots session cookie found",
        details:
          "Please authenticate your SportLots account from Profile.",
      };
    }

    try {
      // Validate by fetching a protected page
      const response = await slFetch(NEWINVEN_URL, {
        method: "GET",
        headers: { Cookie: sessionCookie },
      });

      const html = await response.text();

      if (isSessionExpired(html)) {
        return {
          success: false,
          message: "SportLots session expired",
          details: "Re-authenticate from Profile to get a fresh session cookie.",
        };
      }

      return {
        success: true,
        message: "SportLots session is active",
        details: "Session cookie is valid.",
      };
    } catch (error) {
      console.error("Error testing Sportlots credentials:", error);
      return {
        success: false,
        message: "Failed to test Sportlots credentials",
        details: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
      };
    }
  },
});
