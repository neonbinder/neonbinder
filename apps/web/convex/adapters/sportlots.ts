"use node";

import { action, ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { primaryId } from "../platformSlots";
import {
  platformServesLevel,
  unsupportedLevelMessage,
} from "../platformLevels";
import { displayVariationLabel } from "../../lib/cards/variations";
import { api, internal } from "../_generated/api";
import { getCurrentUserId, requireAdmin } from "../auth";
import { Id } from "../_generated/dataModel";
import {
  recordAdapterCall,
  recordAdapterPhase,
  newRequestId,
  classifyAdapterError,
} from "../observability";
// NEO-198: this adapter's retry policy and the aggregator's per-child deadline
// are the same fact and now have one definition. Importing a plain (non-node)
// module from a "use node" one is fine; the reverse is not, which is why the
// numbers live there rather than here.
import { SL_SELECTOR_BUDGET } from "./selectorBudgets";

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
//
// NEO-198: these are local aliases of SL_SELECTOR_BUDGET rather than
// literals. The aggregator's SL_CHILD_DEADLINE_MS is derived from the same
// object, so bumping a retry here automatically widens the deadline that has to
// contain it — which is the drift that produced a 12s deadline over a 16s
// ceiling. `convex/adapters/selectorBudgets.test.ts` fails if they part ways.
const SL_SELECTOR_FETCH_TIMEOUT_MS = SL_SELECTOR_BUDGET.perAttemptTimeoutMs;
const SL_SELECTOR_FETCH_MAX_ATTEMPTS = SL_SELECTOR_BUDGET.maxAttempts;
// Settle-in sleep between a forced re-auth and the re-POST in the empty-result
// recovery loop below. Named because it is part of the exported ceiling.
const SL_SELECTOR_EMPTY_RETRY_BACKOFF_MS =
  SL_SELECTOR_BUDGET.emptyRetryBackoffMs;

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
    // NEO-137: platformData.sportlots is a SLOT MAP now. Interpolating it
    // straight into the request body produced "[object Object]" as the SL
    // set radio id, which matches nothing.
    return (option ? primaryId(option, "sportlots") : undefined) || displayValue;
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

    // NEO-216 — BEFORE the session cookie. SportLots does not model NB's
    // `setName` / `variantType` splits (those come from BSC) and has no
    // `parallel` concept; see convex/platformLevels.ts. This check used to sit
    // BELOW `getSportLotsCookie`, so a Sync Variant Types paid a real SL
    // session round-trip only to return an empty list.
    //
    // It used to return `success: true, options: []`, which is the dangerous
    // spelling: an empty successful side is exactly the statement that
    // licenses NEO-211's unlink pass to detach SL links. "SportLots has no
    // such level" is not "SportLots was asked and had nothing", and the two
    // must not share a representation. Callers now read the table and do not
    // call us here; this is the backstop for one that does not.
    if (!platformServesLevel("sportlots", args.level)) {
      await recordAdapterCall(ctx, {
        requestId,
        operation: "fetchSportLotsSelectorOptions",
        platform: "sportlots",
        level: args.level,
        parentSport: args.parentFilters.sport,
        parentYear: args.parentFilters.year,
        parentSetName: args.parentFilters.setName,
        duration_ms: Date.now() - start,
        success: false,
        result_count: 0,
        stage: "adapter",
        error_class: "unsupported_level",
      });
      return {
        success: false,
        options: [],
        message: unsupportedLevelMessage("sportlots", args.level),
      };
    }

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

      // NEO-198 — publish progress BEFORE anything downstream can hang.
      // fetchAggregatedOptions abandons this action at SL_CHILD_DEADLINE_MS and
      // then has no return value to read `tokenMs` off, so it cannot tell an
      // auth stall from a marketplace stall. This breadcrumb is the only thing
      // that survives the abandonment: joined by requestId, its presence means
      // the token resolved and the hang is downstream; its absence means we
      // never got out of getSiteToken. Emitted only once the cookie is in hand
      // — the no-cookie path above already records a real call with stage:"auth".
      recordAdapterPhase(ctx, {
        requestId,
        operation: "fetchSportLotsSelectorOptions",
        platform: "sportlots",
        level: args.level,
        phase: "token_ready",
        elapsed_ms: tokenMs,
      });

      // NEO-216: the setName / variantType special case that used to live here
      // moved ABOVE the cookie fetch and into the shared
      // `platformServesLevel` table — this is unreachable ground now.

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
        await new Promise((resolve) =>
          setTimeout(resolve, SL_SELECTOR_EMPTY_RETRY_BACKOFF_MS),
        );
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
 * NEO-189 — pull a VARIATION marker out of a SportLots card description.
 *
 * SportLots appends a bracketed suffix to a variation and leaves the card
 * number IDENTICAL to its parent's. Confirmed live 2026-08-27/28:
 *
 *   2021 Topps Heritage (set 189991)
 *     11  … #11 Alec Bohm|Spencer Howard
 *     11  … #11 Alec Bohm [ VAR Action Image ]
 *
 *   2021 Topps (set 328996 era)
 *     1   … #1 Fernando Tatis Jr.
 *     1   … #1 Fernando Tatis Jr. [ Sliding ]
 *     1   … #1 Fernando Tatis Jr. [ In Dugout ]
 *
 * THE `VAR` PREFIX IS OPTIONAL. The first version of this required it, so an
 * entire set written the second way — every 2021 Topps photo variation —
 * parsed as an ordinary card. BSC flagged its side (`1b`, `1c`), SportLots
 * did not flag its own, nothing paired, and 524 BSC-only sat opposite 88
 * SL-only rows that were the very same cards.
 *
 * So the bracket itself is the marker and `VAR` is stripped when present.
 *
 * ## The one thing a bracket does NOT mean
 *
 * A bracket holding nothing but a known attribute token — `[ SP ]`, `[ RC ]` —
 * is describing the card, not naming a second version of it. Those are left
 * alone; `tokenizeSlDescription` picks them up as attributes.
 *
 * The residual risk is a bracket that is neither: a genuinely new convention
 * would be read as a variation name. That is the safer direction to fail —
 * a mislabelled variation is visible in the review modal and fixable, whereas
 * the previous failure silently dropped whole sets of pairings.
 *
 * Returns SL's RAW label. It is not translated: which NeonBinder name it and
 * BSC's wording both mean is settled when the two are paired, not guessed by
 * an adapter.
 */
/**
 * Bracket contents that describe the card rather than name a variation of it.
 * Mirrors the tokens `tokenizeSlDescription` already lifts into attributes.
 */
const SL_BRACKET_ATTRIBUTE_TOKENS = new Set([
  "SP",
  "SSP",
  "RC",
  "AU",
  "RELIC",
  "MEM",
  "VAR",
]);

export function parseSlVariationMarker(desc: string): {
  isVariation: boolean;
  /** SportLots' own wording for this card's variation, untranslated. */
  variationLabel?: string;
  residual: string;
} {
  // `VAR ` is optional — see the note above. Tolerant of internal spacing.
  const m = desc.match(/\s*\[\s*(?:VAR\s+)?([^\]]+?)\s*\]\s*/i);
  if (!m) return { isVariation: false, residual: desc };
  const inner = m[1].trim();
  // A bracket holding only an attribute token describes the card rather than
  // naming a second version of it.
  if (SL_BRACKET_ATTRIBUTE_TOKENS.has(inner.toUpperCase())) {
    return { isVariation: false, residual: desc };
  }
  const residual = (desc.slice(0, m.index) + desc.slice(m.index! + m[0].length))
    .replace(/\s+/g, " ")
    .trim();
  return {
    isVariation: true,
    variationLabel: displayVariationLabel(inner),
    residual,
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
        // NEO-189: does this source consider the row a variation of another
        // card? A domain answer, not a marketplace field.
        isVariation: v.optional(v.boolean()),
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

      // Look up the set's platformData.sportlots (the radio button ID).
      // SL has no setName-level concept — it combines set+variant at the
      // insert/parallel level (see fetchCardChecklist's own comment on this
      // in selectorOptions.ts), so the resolved id lives under one of
      // variantType/insert/parallel, never setName. Deepest level wins,
      // matching fetchSl's own variantSlIds precedence in selectorOptions.ts.
      // Bug fix (NEO-91): this used to read only platformFilters.setName,
      // which is never populated, so setRadioId always fell through to the
      // raw display string and SL's per-card fetch silently matched nothing.
      let setRadioId =
        args.platformFilters?.parallel
        || args.platformFilters?.insert
        || args.platformFilters?.variantType
        || args.platformFilters?.setName
        || args.parentFilters.setName
        || "";

      // Fall back to DB lookup if we don't have a pre-resolved platform value
      // at any of those levels.
      if (
        !args.platformFilters?.parallel
        && !args.platformFilters?.insert
        && !args.platformFilters?.variantType
        && !args.platformFilters?.setName
        && args.parentFilters.setName
      ) {
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

      // Parse card table rows.
      //
      // Pattern: <td class="small(color)?left">CARD_NUMBER</td>
      //          <td class="smallleft">DESCRIPTION</td>
      //
      // NEO-189 — the number cell carries a DIFFERENT class on a variation row.
      // SportLots tints the card number when a row is a variation of the row
      // above it, and it does that by swapping the class:
      //
      //   base row       <td class="smallleft">20</td>
      //                  <td class="smallleft">2025 Topps Base Set #20 Coby Mayo</td>
      //   variation row  <td class="smallcolorleft">20</td>
      //                  <td class="smallleft">… #20 Coby Mayo [ VAR Factory Set ]</td>
      //
      // Verified against the live listcards page for set 328996 on 2026-08-27.
      //
      // The old pattern required "smallleft" on BOTH cells, so it matched the
      // base row and skipped the variation entirely — silently, since a
      // non-matching row is simply not a row. Every SportLots variation has
      // therefore been invisible to NeonBinder: a 2025 Topps sync reported
      // "0 SL-only" and paired 0 variations, and both numbers looked like
      // "SportLots does not carry these" rather than "we never parsed them".
      //
      // Only the number cell varies; the description cell stays "smallleft".
      const cardRegex = /<td class="small(?:color)?left">([^<]+)<\/td>\s*<td class="smallleft">([^<]+)<\/td>/gi;
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
        /** NEO-189: SL marks a variation with ` [ VAR … ] ` and keeps the
         *  parent's card number, so this flag is the only thing separating
         *  these rows from the card they vary. */
        isVariation?: boolean;
        platformRef?: string;
        sportlotsRef?: string;
      }> = [];

      // PAGINATE. `start` is a 1-BASED OFFSET INTO SL'S LISTING TABLE, not a
      // page number, and SL's stride is a fixed 100 LISTINGS per request.
      //
      // Crucially, listings != parsed card rows: a request returns up to 100
      // listings, but the number of rows matching the card pattern VARIES.
      // Measured live on selset=309098 (2024 Topps Chrome Base, 300 cards):
      //
      //   start=1   -> 88 rows, cards #1..#88
      //   start=101 -> 92 rows, cards #89..#180
      //   start=201 -> 89 rows, cards #181..#269
      //   start=301 -> 31 rows, cards #270..#300
      //   start=401 ->  0 rows  <- the only reliable end-of-set signal
      //
      // and on selset=3628 that `start` is an offset, not an index:
      //   start=1 -> #1..#100, start=2 -> #2..#101, start=101 -> #101..#200.
      //
      // Two consequences, both learned the hard way:
      //
      //   1. ADVANCE BY A FIXED 100, never by rows parsed. Advancing by rows
      //      (88) would request start=89 and re-read cards #77..#164 — both
      //      duplicating and, at the tail, skipping.
      //   2. STOP ONLY ON AN EMPTY PAGE. Stopping on "fewer rows than a full
      //      page" ends the walk at page one for this very set, since page one
      //      legitimately yields 88.
      //
      // Before pagination existed this POSTed once with start=1, so any set
      // over one page silently truncated. The reconciliation modal then showed
      // "SportLots only (0)" against hundreds of BSC-only rows, which reads
      // like a matching bug rather than a fetch bug.
      const SL_PAGE_STRIDE = 100;
      // Safety valve: bounds the loop if SL ever returns a non-empty page
      // forever. 200 pages = 20k listings, far beyond any real set.
      const SL_MAX_PAGES = 200;
      let start = 1;
      let lastPageFingerprint = "";

      for (let page = 0; page < SL_MAX_PAGES; page++) {
        const formData = new URLSearchParams({
          selset: setRadioId,
          dcond: "NM",
          dbin: "1",
          dval: "0.18",
          dentry: "ADD",
          pricing: "OLD",
          start: String(start),
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
          // Fail the whole fetch rather than silently returning a partial
          // checklist — a truncated set is exactly the bug this loop fixes,
          // and committing one would persist missing cards.
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

        // Collect this page separately so an unchanged page can be detected
        // and discarded BEFORE it contributes duplicates.
        const pageCards: typeof cards = [];
        cardRegex.lastIndex = 0;
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

          // NEO-189: lift SL's ` [ VAR … ] ` marker before tokenizing, so the
          // marker never lands in cardName and the variation signal reaches
          // the domain. SL keeps the parent's card number, so this flag is the
          // ONLY thing distinguishing these rows from their parent.
          const {
            isVariation,
            variationLabel,
            residual: withoutVariation,
          } = parseSlVariationMarker(working);

          const { attributes, printRun, residual } =
            tokenizeSlDescription(withoutVariation);
          const cardName = residual || withoutVariation || fullDescription;

          pageCards.push({
            cardNumber,
            cardName,
            attributes: attributes.length ? attributes : undefined,
            printRun,
            autographType: attributes.includes("AU") ? "Unknown" : undefined,
            // NEO-189: SportLots' answer to the domain question, plus its own
            // wording for the variation. Untranslated — see parseSlVariationMarker.
            isVariation: isVariation || undefined,
            cardVariation: variationLabel,
            // NEO-91: the raw, un-tokenized description (not the bare card
            // number) — this is what lands in cardChecklist.platformData.
            // sportlots. SL reuses the same cardNumber across variation rows
            // ("#10 Aaron Judge" vs "#10 Aaron Judge [ VAR All-Star Logo ]"),
            // so only the full text disambiguates which SL row this card
            // actually matched. sportlotsRef stays the bare number — that's
            // still the correct key for BSC↔SL reconciliation matching below.
            platformRef: fullDescription,
            sportlotsRef: cardNumber,
          });
        }

        // An EMPTY page is the only reliable end-of-set signal — see above.
        // A short page is normal mid-set (88, 92, 89, 31 … all precede more
        // data), so breaking on one truncates the walk.
        if (pageCards.length === 0) break;

        // Defence against a `start` that does not advance. If SL ever ignores
        // the offset and re-serves the same page, appending would duplicate
        // every row and the walk would only stop at SL_MAX_PAGES — 200 live
        // requests. Comparing the page's identity fingerprint stops it at two.
        const fingerprint = `${pageCards.length}|${pageCards[0].cardNumber}|${pageCards[0].platformRef}`;
        if (fingerprint === lastPageFingerprint) break;
        lastPageFingerprint = fingerprint;

        cards.push(...pageCards);
        start += SL_PAGE_STRIDE;
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

