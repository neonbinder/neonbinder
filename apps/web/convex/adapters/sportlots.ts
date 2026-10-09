"use node";

import { action, internalAction, ActionCtx } from "../_generated/server";
import { v } from "convex/values";
// NEO-237 — the all-brands predicate and the one brand-prefix matcher. Both
// pure; the adapter compares a marketplace id to marketplace vocabulary and
// applies an NB-owned prefix to the PARSED response, never to the request.
import { isSlAllBrandsBrandId } from "../slBrandAxis";
import {
  matchesBrandPrefix,
  stripMatchedBrandPrefix,
} from "../selectorSyncMatch";
import {
  platformServesLevel,
  unsupportedLevelMessage,
} from "../platformLevels";
// NEO-325 — the per-level REQUIRED scope. One table, read by the chain gate
// (`resolvableSides`) and by `resolveSlScope` below, so the two cannot drift.
import { SL_SCOPE_BY_LEVEL } from "../marketplaceResolvability";
// NEO-251: the parser below refuses against NB's OWN bounds rather than
// re-declaring them. A number duplicated here would drift from the mutation
// that actually enforces it, and the adapter would start minting names the
// player table rejects.
//
// The name bound lives in `lib/` rather than in `convex/players.ts` because
// the pairing modal enforces it too and a browser bundle cannot import
// `./_generated/server`. See the note in that file.
import { MAX_PLAYER_NAME_LENGTH } from "../../lib/players/name-limits";
import { MAX_CARD_PLAYERS } from "../features/cardAttention";
import { displayVariationLabel } from "../../lib/cards/variations";
import { internal } from "../_generated/api";
import { getCurrentUserId, requireAdmin } from "../auth";
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
// NEO-287 — the operator switch. Checked at the top of both public actions,
// BEFORE the session cookie is asked for: a paused marketplace is contacted
// for nothing, not even a stored-session check. The sync entry points already
// skip a paused side via `resolvableSides`; these guards are the adapter's own
// backstop for any caller that reaches it directly.
import { isPlatformPaused } from "../marketplacePause";
import { pausedSyncMessage } from "../selectorSyncStore";
// NEO-321 follow-up — a structured reason beside `success: false`, and the
// self-imposed-limiter log line.
// NEO-325 — the Base match probe's bounds, wire shapes and "first card" rule,
// shared with the default-runtime actions in `convex/baseMatchProbe.ts`.
import {
  MAX_SL_COUNT_IDS,
  MAX_SL_FIRST_PAGE_IDS,
  MAX_SL_PROBE_ID_LENGTH,
  SL_PROBE_CONCURRENCY,
  SL_PROBE_COUNT_MAX_PAGES,
  SL_PROBE_DEADLINE_MS,
  SL_PROBE_ID_PATTERN,
  checkProbeIds,
  mapWithConcurrency,
  slListcardsSummaryValidator,
  summarizeProbeCards,
  type SlListcardsSummary,
} from "../lib/baseMatchProbe";
import {
  fetchFailureValidator,
  isAbortTimeout,
  logMarketplaceLimiter,
  type FetchFailure,
} from "../lib/marketplaceFetchFailure";

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

/**
 * NEO-321 follow-up — our own abort timer fired on a SportLots request. A
 * distinct class so a caller can tell it from a network throw without reading
 * the message; the message is unchanged.
 */
export class SlFetchTimeoutError extends Error {
  constructor(
    readonly timeoutMs: number,
    url: string,
  ) {
    super(`SportLots request timed out after ${timeoutMs / 1000}s: ${url}`);
  }
}

/** The page a SportLots URL names (`listcards`), never its host or query. */
function slPageName(url: string): string {
  const path = url.split(/[?#]/)[0];
  return (path.split("/").pop() ?? "").replace(/\.tpl$/, "") || "unknown";
}

async function slFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number = SL_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const startedAt = Date.now();
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (isAbortTimeout(err)) {
      // NEO-321 follow-up — our timer, not SportLots: log it as a limiter.
      logMarketplaceLimiter({
        limiter: "sl_fetch_timeout",
        platform: "sportlots",
        operation: slPageName(url),
        waitedMs: Date.now() - startedAt,
        timeoutMs,
        outcome: "aborted",
      });
      throw new SlFetchTimeoutError(timeoutMs, url);
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
 * NEO-239 — the SportLots request scope, built from SLOT IDS ONLY.
 *
 * SportLots scopes every set query with three form fields: `sprt`, `yr`,
 * `brd`, and each one comes from `platformFilters` — the caller's ids, read
 * off the rows' platform slots — and nowhere else. A name is never sent as an
 * id, and an empty `brd` would widen the query to every brand in the year
 * rather than narrow it. A refusal is an error, so the caller's
 * `coveredSides` never reads it as positive evidence.
 *
 * NEO-256 / NEO-242: there is no name→id lookup behind this any more; the old
 * by-name DB fallback is deleted. `parentFilters` never reaches the wire.
 *
 * NEO-325 (security audit) — the REQUEST LEVEL decides the shape, never
 * `parentFilters`. The first version skipped any level `parentFilters` did not
 * name BEFORE reading its id, so a client that sent a brand id with no brand
 * name (`parentFilters` is client-supplied on two public actions) got an empty
 * `brd`: the widened every-brand-in-the-year list, stored under the brand it
 * asked about. Now, in this order:
 *
 *   1. Every id supplied in `platformFilters` is sent. An id only narrows.
 *   2. `SL_SCOPE_BY_LEVEL[level]` is the REQUIRED set for this request; a
 *      required level with no id refuses it.
 *   3. A level `parentFilters` names with no id also refuses it — the caller
 *      declared a scope it cannot supply. Naming a level can only add a
 *      refusal; it can never drop an id or loosen a requirement.
 *
 * A level absent from `SL_SCOPE_BY_LEVEL` is one SportLots does not answer;
 * the adapter refuses those earlier (`platformServesLevel`), and this refuses
 * them again rather than guess a scope.
 */
const SL_UNSCOPED_MESSAGE =
  "SportLots was not queried: this path has no SportLots ids to scope the " +
  "request with.";

type SlParentFilters = {
  sport?: string;
  year?: string;
  manufacturer?: string;
  setName?: string;
  variantType?: string;
};

const SL_SCOPE_FIELDS = [
  ["sport", "sprt"],
  ["year", "yr"],
  ["manufacturer", "brd"],
] as const;

function resolveSlScope(
  level: string,
  parentFilters: SlParentFilters,
  platformFilters?: Record<string, string>,
): {
  fields: { sprt?: string; yr?: string; brd?: string };
  missing: string[];
} {
  const fields: { sprt?: string; yr?: string; brd?: string } = {};
  const missing: string[] = [];

  const required = Object.prototype.hasOwnProperty.call(
    SL_SCOPE_BY_LEVEL,
    level,
  )
    ? SL_SCOPE_BY_LEVEL[level]
    : undefined;
  if (required === undefined) {
    return { fields, missing: [`level=${level}`] };
  }

  for (const [scopeLevel, field] of SL_SCOPE_FIELDS) {
    // Sent byte-exact; a whitespace-only id is no id.
    const id = platformFilters?.[scopeLevel];
    if (id !== undefined && id.trim() !== "") {
      fields[field] = id;
      continue;
    }
    if (required.includes(scopeLevel) || parentFilters[scopeLevel]) {
      missing.push(scopeLevel);
    }
  }

  return { fields, missing };
}

/**
 * NEO-239 — the ONE place an NB display value may touch SportLots data, and
 * the direction matters.
 *
 * SportLots names its sets with the brand in front: "Topps Series 1", where NB
 * files "Series 1" under a manufacturer row called "Topps". A fresh NB row
 * seeds its display value from what comes back here, so leaving the prefix on
 * gives every synced set a name that duplicates its own parent — and, worse,
 * on a RE-sync of rows created before this the stored SL label then disagrees
 * with every NB value, and NEO-211's suggestion query nags a rename on every
 * set in the year, forever.
 *
 * This is DERIVATION, which the product invariant allows ("a row may be derived
 * from marketplace data when it is created"), not a query input. The
 * distinction is enforced by shape, not by discipline: `labelContext` is a
 * separate parameter from `parentFilters`, it is read only AFTER the response
 * has been parsed, and `resolveSlScope` — the only thing that builds the
 * request body — cannot see it. A caller that passes a manufacturer here is
 * cleaning labels; a caller that wants to scope a request must supply a slot
 * id, and is refused otherwise.
 *
 * Case-sensitive, matching what shipped before NEO-239 removed it:
 * "Topps Series 1" + "Topps" → "Series 1"; "Bowman Chrome" + "Topps" →
 * unchanged.
 *
 * TWO corrections to the original, both cases where it damaged a label:
 *
 *   WORD BOUNDARY. A bare `startsWith` turned "Toppstown Retro" into "town
 *   Retro" — a real SportLots set silently renamed to nonsense, and worse, one
 *   NB then seeds a row's display value from. The character after the prefix
 *   must be absent or non-alphanumeric, so the brand has to be a whole word.
 *
 *   NEVER STRIP TO NOTHING. A label that IS exactly the brand kept its name
 *   rather than becoming "" and then being dropped entirely by the caller's
 *   `if (radioId && setName)` guard. Losing a set because SportLots happened to
 *   name it after its brand is not a cleanup.
 */
export function stripBrandPrefixForLabel(
  label: string,
  manufacturer: string | undefined,
): string {
  const brand = manufacturer?.trim();
  if (!brand || !label.startsWith(brand)) return label;
  const next = label.charAt(brand.length);
  // "" means the label was exactly the brand — handled by the empty check
  // below. Anything alphanumeric means the brand is a PREFIX OF A LONGER WORD
  // and this is a different set that merely starts with the same letters.
  if (next && /[a-zA-Z0-9]/.test(next)) return label;
  const stripped = label.slice(brand.length).trim();
  return stripped.length > 0 ? stripped : label;
}

/** What `labelContext` carries. Display values, for LABELS ONLY. */
export type SlLabelContext = { manufacturer?: string };

/**
 * NEO-237 — what `brandScope` carries: the manufacturer row's OWN
 * `metadata.setNamePrefix`, an NB fact about the row (never its display
 * value). A RESPONSE filter, applied in `fetchSetNames` after the parse and
 * only when the request's `brd` is SportLots' all-brands option
 * (`isSlAllBrandsBrandId`): that list is every set in the year, and a brand
 * linked THROUGH the all-brands option (Bandai, Choice — SportLots has no
 * entry for them) sees only the sets that start with its prefix. A row with
 * its own SportLots brand id is untouched by construction, so callers pass
 * the ancestor's prefix unconditionally.
 *
 * Separate from `labelContext` (labels only, every request) and from
 * `platformFilters` (the request body) so that neither the strip nor the
 * scope can drift into the other's job.
 */
export type SlBrandScope = { setNamePrefix: string };

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
    // SportLots ids keyed by level (e.g., { sport: "BB", year: "2024" }), read
    // by the caller off the rows' platform slots. The only source of request
    // ids: a level named in parentFilters with no id here is refused.
    platformFilters: v.optional(v.record(v.string(), v.string())),
    /**
     * NEO-239 — NB display values used ONLY to clean the labels this action
     * returns. SportLots prefixes its set names with the brand ("Topps Series
     * 1") where NB files "Series 1" under a "Topps" manufacturer row, and a
     * fresh NB row seeds its display value from what comes back here.
     *
     * NOT a filter, and structurally incapable of becoming one: it is read
     * after the response is parsed, by `stripBrandPrefixForLabel`, and the
     * request body is built entirely from `platformFilters` slot ids.
     */
    labelContext: v.optional(v.object({ manufacturer: v.optional(v.string()) })),
    /**
     * NEO-237 — the manufacturer row's `metadata.setNamePrefix`, for the
     * all-brands narrowing at the `insert` level. See `SlBrandScope`. Ignored
     * at every other level and whenever `brd` is a real SportLots brand id.
     */
    brandScope: v.optional(v.object({ setNamePrefix: v.string() })),
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

    // NEO-287 — paused: refuse BEFORE `getSportLotsCookie`, so no token read,
    // no refresh and no stored-session login happens on this marketplace.
    // `success: false` on purpose — the same reasoning as the unsupported-level
    // branch above: an empty SUCCESS would enter `coveredSides` and license the
    // unlink pass to detach every SportLots id under this parent.
    if (isPlatformPaused("sportlots")) {
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
        error_class: "paused",
      });
      return {
        success: false,
        options: [],
        message: pausedSyncMessage(["sportlots"]),
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
        const insertResult = await fetchSetNames(
          sessionCookie,
          args.parentFilters,
          args.platformFilters,
          args.labelContext,
          args.brandScope,
        );
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
      const scope = resolveSlScope(
        args.level,
        args.parentFilters,
        args.platformFilters,
      );
      if (scope.missing.length > 0) {
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
          result_count: 0,
          stage: "adapter",
          error_class: "precondition_missing_slot_id",
        });
        console.warn(
          `[fetchSportLotsSelectorOptions] refusing an unscoped request — ` +
            `no SportLots id on: ${scope.missing.join(", ")}`,
        );
        return { success: false, options: [], message: SL_UNSCOPED_MESSAGE };
      }
      const formData = new URLSearchParams();
      if (scope.fields.sprt) formData.set("sprt", scope.fields.sprt);
      if (scope.fields.yr) formData.set("yr", scope.fields.yr);
      if (scope.fields.brd) formData.set("brd", scope.fields.brd);

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

      // NEO-287 (Decision 12) — still empty after every retry, and NOT the
      // login stub: this is the "challenge page" shape (a 200 that parses to
      // nothing — a Cloudflare interstitial, an attack banner, a redesigned
      // form). Per the comment above the retry loop, sport / year /
      // manufacturer are ALWAYS populated on a valid session, so an empty
      // answer here is a broken fetch, never an empty marketplace. It used to
      // return `success: true, options: []`, which is the one dangerous
      // spelling: an empty successful side enters `coveredSides`, and the
      // store's unlink pass reads "SportLots returned nothing" as "SportLots
      // dropped every set" and detaches every SL id under this parent
      // (invariant 5). A failure is retried by the operator; a lost link is
      // re-attached by hand, one row at a time.
      if (parsedOptions.length === 0) {
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
          result_count: 0,
          stage: "marketplace_fetch",
          attempt: selectorAttempt,
          error_class: "empty_after_retries",
        });
        return {
          success: false,
          options: [],
          message:
            "SportLots didn't give us a straight answer — that's a hiccup on their end, not an empty set. Nothing changed; try again in a minute.",
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
        success: true,
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
  sessionCookie: string,
  parentFilters: {
    sport?: string;
    year?: string;
    manufacturer?: string;
  },
  platformFilters?: Record<string, string>,
  /**
   * NEO-239 — display values used ONLY to clean the labels that come back.
   * Deliberately a separate parameter from `parentFilters`: nothing below the
   * fetch reads it, and `resolveSlScope` (which builds the request body) is
   * not given it at all. See `stripBrandPrefixForLabel`.
   */
  labelContext?: SlLabelContext,
  /**
   * NEO-237 — the brand's own set-name prefix. Read only AFTER the parse, and
   * only when `scope.fields.brd` is the all-brands option; see `SlBrandScope`.
   * `resolveSlScope` is not given it, so it cannot reach the request body.
   */
  brandScope?: SlBrandScope,
): Promise<{ success: boolean; options: Array<{ value: string; platformValue: string }>; message?: string }> {
  // NEO-239 — every scope field is a SportLots id or the request is refused.
  // `brd: ""` is not a narrower request, it is a request for every brand in
  // the year, and the caller would have stored that superset under whichever
  // manufacturer row it asked about.
  const scope = resolveSlScope("insert", parentFilters, platformFilters);
  if (scope.missing.length > 0) {
    console.warn(
      `[fetchSetNames] refusing an unscoped request — no SportLots id on: ` +
        `${scope.missing.join(", ")}`,
    );
    return { success: false, options: [], message: SL_UNSCOPED_MESSAGE };
  }

  const commonFields: Record<string, string> = {
    sprt: scope.fields.sprt ?? "",
    yr: scope.fields.yr ?? "",
    brd: scope.fields.brd ?? "",
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

  // NEO-237 — is this the ALL-BRANDS list? Decided from the id the request
  // actually carried (`scope.fields.brd`, a slot id), never from a row's name.
  // Only then does `brandScope` do anything: the list is every set in the
  // year, and the brand that asked owns the ones starting with its prefix.
  // A real brand id got its own list from SportLots and is never narrowed —
  // and keeps today's case-sensitive `labelContext` strip, so no NEO-211
  // rename suggestion churns on a re-sync of rows named before this.
  const narrowTo =
    brandScope && isSlAllBrandsBrandId(scope.fields.brd)
      ? brandScope.setNamePrefix.trim()
      : undefined;
  if (narrowTo === "") {
    // A brand linked via All Brands with an EMPTY prefix would receive every
    // set in the year as its own. That is not a wider version of its list; it
    // is a different list, and the unlink pass would act on it.
    console.warn(
      `[fetchSetNames] refusing to narrow the all-brands list by an empty ` +
        `prefix — nothing returned`,
    );
    return { success: false, options: [], message: SL_UNSCOPED_MESSAGE };
  }

  // Parse radio buttons: <input type="radio" Name="selset" Value="12345"> </td> <td>123  Set Name Here</td>
  const radioRegex = /<input\s+type="radio"\s+Name="selset"\s+Value="(\d+)"[^>]*>\s*<\/td>\s*<td>\d+\s+([^<]+)<\/td>/gi;
  const options: Array<{ value: string; platformValue: string }> = [];
  let match;

  while ((match = radioRegex.exec(html)) !== null) {
    const radioId = match[1].trim();
    const rawLabel = match[2].trim();
    // Applied HERE, to the parsed response, and nowhere else. The request has
    // already gone out, built from slot ids only.
    let setName: string;
    if (narrowTo !== undefined) {
      if (!matchesBrandPrefix(rawLabel, narrowTo)) continue;
      setName = stripMatchedBrandPrefix(rawLabel, narrowTo);
    } else {
      setName = stripBrandPrefixForLabel(rawLabel, labelContext?.manufacturer);
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
 * cardName with false positives.
 *
 * ## Players ARE derived from the residual; teams still are NOT (NEO-251)
 *
 * `parseSlSubjects` below reads player names out of this residual. That is a
 * change from the original note here, and the reason is concrete: an SL-only
 * set used to commit with every row "needs attention" and the entity-review
 * wizard never opened for it, because no SL row ever carried a `players`
 * array. Names are the one thing SL's description reliably contains, so the
 * adapter now derives them — as an *initial input* at creation, exactly as
 * the product invariant allows, never as a source of truth afterwards.
 *
 * Teams remain deliberately underived, and the reason is now sharper than
 * "BSC supplies it":
 *
 *   1. SportLots does not print a team. What it prints is a 2-3 letter
 *      abbreviation glued onto the description ("Mike Trout LAA"), whose
 *      meaning varies by sport and by era, and which is absent from most
 *      rows entirely.
 *   2. Turning `LAA` into an NB team would mean looking an NB row up *by a
 *      marketplace display string* — the reverse dependency the invariant
 *      forbids. NB's team rows carry marketplace ids in their platform
 *      slots; there is no id here to read, only text, and guessing by name
 *      is precisely the smell the invariant names.
 *
 * So the abbreviation is stripped off a candidate name (below) and dropped on
 * the floor. `team`/`teams` stay `undefined` on every SportLots row.
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
 * The exact HTML entities SportLots emits inside a `listcards.tpl` cell.
 *
 * A CLOSED set, not a general decoder, and that is the security property:
 * an unknown `&…;` sequence is left as literal text rather than resolved,
 * so nothing can be smuggled through by inventing an entity name. Decoding
 * runs in ONE pass — `String.replace` never re-scans what it substituted —
 * so `&amp;lt;` decodes to the literal `&lt;` and stops there.
 *
 * Call this ONCE per row, at the head of the derivation path. `parseSlSubjects`
 * deliberately does not call it — decoding twice would resolve
 * `&amp;lt;` all the way to `<`, and would mean no single place owned the
 * question of what the row says.
 */
const SL_ENTITY_REPLACEMENTS: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&#x27;": "'",
  "&nbsp;": " ",
};
const SL_ENTITY_PATTERN = /&(?:amp|lt|gt|quot|apos|nbsp|#39|#x27);/gi;

/**
 * Decode the bounded entity set above, once, without re-scanning.
 *
 * Applied per row at the head of the DERIVATION path, so `cardName`, the
 * attributes, the variation label and the player parse all see the same
 * decoded text — an apostrophe in "Peter O&#39;Brien" is a real apostrophe in
 * every derived field or in none. It is NOT applied to `platformRef`, which
 * is an identity key and must stay byte-identical to what SL served.
 */
export function decodeSlEntities(text: string): string {
  return text.replace(
    SL_ENTITY_PATTERN,
    (m) => SL_ENTITY_REPLACEMENTS[m.toLowerCase()] ?? m,
  );
}

/** Lowercase particles that may appear inside a name ("Alfonso de la Cruz"). */
const SL_NAME_PARTICLES = new Set([
  "de",
  "la",
  "van",
  "von",
  "da",
  "di",
  "del",
  "du",
  "the",
  "of",
  "y",
]);

/**
 * Generational suffixes. Compared case-insensitively.
 *
 * The bare, period-less `JR`/`SR` are in here for a reason that is easy to
 * miss: without them "Ken Griffey JR" hits the trailing-team-code rule below,
 * `JR` gets stripped as if it were an abbreviation like `LAA`, and the row
 * emits "Ken Griffey" — a DIFFERENT PERSON, silently, on a card that names
 * the son. Wrong player data is worse than none, and a father/son pair is
 * exactly where SportLots prints the bare form.
 */
const SL_NAME_SUFFIXES = new Set([
  "jr",
  "sr",
  "jr.",
  "sr.",
  "ii",
  "iii",
  "iv",
  "v",
]);

/**
 * Whole-word veto list. If any of these appears as a word anywhere in a
 * candidate subject, the WHOLE row is rejected — "Team Checklist", "Yankee
 * Stadium", "Header Card" and friends are not people, and a bad player name
 * committed against a card is worse than no player name at all.
 *
 * ## Why the second group exists
 *
 * The shape rules alone cannot see the difference between "Coby Mayo" and
 * "Future Stars": both are two capitalised tokens. Subset and insert names
 * are the single largest class of non-person text SportLots prints in the
 * subject position, and they pass every structural test. Left unvetoed they
 * do real damage twice over — a bogus player minted into NB's own table, and
 * a spurious BSC-vs-SL disagreement on a card where nothing is actually
 * wrong.
 *
 * ## Plural and descriptor-specific, on purpose
 *
 * These are surnames as well as descriptors, so the entries are chosen to
 * catch the descriptor WITHOUT vetoing the person:
 *
 *   * `kings` vetoes "Diamond Kings"; "Michael King" still parses.
 *   * `stars` vetoes "Future Stars"; a "Star" surname is untouched.
 *   * `legends`, `winners`, `prospects` follow the same plural rule.
 *
 * That is why none of the singular forms appear here. When adding an entry,
 * check it against the surname first — a false veto costs a real name, which
 * is the cost this list is supposed to be avoiding.
 */
const SL_SUBJECT_STOPWORDS = [
  // Structural / non-card rows.
  "checklist",
  "team",
  "card",
  "cards",
  "stadium",
  "logo",
  "puzzle",
  "header",
  "sponsor",
  "coupon",
  "advertisement",
  "league",
  "leaders",
  "highlights",
  "record",
  "season",
  "series",
  "set",
  "base",
  "rookie",
  "cup",
  "all-star",
  "mascot",
  // Subset / insert descriptors. Plural where a singular is a real surname.
  "stars",
  "kings",
  "prospects",
  "legends",
  "tribute",
  "award",
  "winners",
  "draft",
  "pick",
  "future",
  "clock",
].map((word) => new RegExp(`\\b${word.replace(/-/g, "\\-")}\\b`));

/**
 * A single name token: an uppercase letter followed by letters, apostrophes,
 * hyphens or periods. Unicode-aware on purpose — "José Ramírez" and
 * "Jean-Luc Pelletier" are names SportLots really prints, and an ASCII-only
 * class would mangle them into a rejection.
 */
const SL_NAME_TOKEN = /^\p{Lu}[\p{L}'\-.]*$/u;

/** A trailing SportLots team abbreviation ("Mike Trout LAA"). Never emitted. */
const SL_TEAM_ABBREVIATION = /^[A-Z]{2,3}$/;

/** Control characters, including newline. Rejected outright post-decode. */
// eslint-disable-next-line no-control-regex
const SL_CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * The parse cap on subjects per card, and its ceiling.
 *
 * `MAX_CARD_PLAYERS` (20) is what the DB side of NB actually accepts on a
 * card. This parser stops far short of it on purpose: past four subjects a
 * SportLots row is a checklist line, not a card, and guessing names off one
 * is how nonsense reaches NB's player table. Written as a `Math.min` against
 * the shared constant rather than as a bare 4 so the relationship cannot
 * invert: if the DB bound is ever lowered below four, this parser tightens
 * with it instead of emitting rows the DB will refuse.
 */
const SL_MAX_SUBJECTS = Math.min(4, MAX_CARD_PLAYERS);
/** A person's name, after the team abbreviation is stripped. */
const SL_MAX_NAME_TOKENS = 4;
const SL_MIN_NAME_TOKENS = 2;
/**
 * The same bound `convex/players.ts` refuses an over-length name against, so
 * this adapter cannot mint a name the player mutations would reject.
 */
const SL_MAX_SUBJECT_LENGTH = MAX_PLAYER_NAME_LENGTH;

/**
 * NEO-251 — derive player names from a SportLots description residual.
 *
 * Pure, and deliberately pessimistic: ANY doubt about ANY subject rejects the
 * entire row and returns `{}`. A false negative costs one card an
 * auto-filled name, which the entity-review wizard already handles. A false
 * positive writes a nonsense player into NB's own data, which is the thing
 * the product invariant exists to prevent — NB owns players; SportLots is
 * only ever the initial input.
 *
 * A refusal is SILENT and total: `{}`, with no message, no thrown error and
 * no log line. There is deliberately nowhere for the rejected text to be
 * echoed — the caller learns a count of names, never the string that failed.
 *
 * ## Input contract: ALREADY DECODED, exactly once
 *
 * The caller decodes (`decodeSlEntities`) at the head of the derivation path
 * and hands the result here. This function must NOT decode again. It used to,
 * which meant production ran the decoder twice over every row and "decode
 * exactly once" was true of neither path — a string reaching this parser had
 * been through one more pass than the `cardName` beside it, so the two could
 * in principle disagree about what the row said. One decode, one owner.
 *
 * A consequence worth stating: a double-encoded payload is no longer stopped
 * by the `<`/`>` guard, because after the caller's single pass
 * `&amp;lt;script&amp;gt;` is still the literal text `&lt;script&gt;`. It is
 * refused anyway, one layer down, by the per-token allowlist — `&`, `;` and
 * `/` are not name characters. Two independent reasons it cannot get through.
 *
 * The rules, in order:
 *
 *  1. Reject if `<`, `>` or any control character (newline included) is
 *     present. This is the caller's single decode already applied, so an
 *     entity-encoded `<` that resolved during it is caught here.
 *  3. Split into subjects on `|`, ` / ` and ` & ` (the last two require
 *     surrounding spaces, so "A/B" and "R&B" are one subject, not two).
 *  4. More than `SL_MAX_SUBJECTS` (4, under NB's own `MAX_CARD_PLAYERS`)
 *     subjects → reject. A five-name row is a checklist line.
 *  5. Per subject: collapse whitespace, trim; reject if empty, longer than
 *     `MAX_PLAYER_NAME_LENGTH` (NB's own bound, 120), or containing any
 *     digit.
 *  6. Reject on a whole-word stoplist hit.
 *  7. A trailing 2-3 letter ALL-CAPS token is SportLots' team abbreviation.
 *     With at least 2 tokens in front of it, drop it — it is never emitted
 *     (see the note on `tokenizeSlDescription`). With only ONE token in
 *     front ("Ichiro SEA"), REJECT the subject: neither reading is safe.
 *     A generational suffix, bare `JR`/`SR` included, is exempt — it is part
 *     of the name, and stripping it would name the wrong person.
 *  8. The remaining token count must be 2-4. A single token is rejected:
 *     "Ichiro" is a real name, but so is "Checklist", and the adapter
 *     cannot tell them apart.
 *  9. Every remaining token must be a capitalised name token, a lowercase
 *     particle, or a generational suffix.
 * 10. Dedupe case-insensitively within the row; emit `players` only if at
 *     least one name survives.
 */
export function parseSlSubjects(residual: string): { players?: string[] } {
  // NOTE: this does NOT decode. It is handed text the caller has ALREADY
  // decoded exactly once — see the docstring. The guard below therefore runs
  // on the same bytes production derives every other field from.
  if (/[<>]/.test(residual) || SL_CONTROL_CHARS.test(residual)) return {};

  const parts = residual.split(/\||\s\/\s|\s&\s/);
  if (parts.length > SL_MAX_SUBJECTS) return {};

  const players: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const subject = part.replace(/\s+/g, " ").trim();
    if (!subject) return {};
    if (subject.length > SL_MAX_SUBJECT_LENGTH) return {};
    if (/\d/.test(subject)) return {};

    const lowered = subject.toLowerCase();
    if (SL_SUBJECT_STOPWORDS.some((pattern) => pattern.test(lowered))) return {};

    let tokens = subject.split(" ");
    const last = tokens[tokens.length - 1];
    // A trailing 2-3 letter ALL-CAPS token is SportLots' team abbreviation —
    // unless it is a generational suffix, which is part of the name.
    if (
      SL_TEAM_ABBREVIATION.test(last) &&
      !SL_NAME_SUFFIXES.has(last.toLowerCase())
    ) {
      // It can only be dropped if a whole name is left standing without it.
      // With just one token in front ("Ichiro SEA") there are two readings —
      // a one-word name plus a team code, or a genuine two-token name — and
      // the parser cannot tell them apart. Emitting "Ichiro SEA" would put a
      // marketplace team code inside an NB player name; stripping to "Ichiro"
      // would emit the single-token name rule 8 exists to refuse. So refuse
      // the subject instead of picking one.
      if (tokens.length < 3) return {};
      tokens = tokens.slice(0, -1);
    }
    if (tokens.length < SL_MIN_NAME_TOKENS || tokens.length > SL_MAX_NAME_TOKENS)
      return {};

    for (const token of tokens) {
      if (SL_NAME_PARTICLES.has(token)) continue;
      if (SL_NAME_SUFFIXES.has(token.toLowerCase())) continue;
      if (!SL_NAME_TOKEN.test(token)) return {};
    }

    const name = tokens.join(" ");
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    players.push(name);
  }

  return players.length ? { players } : {};
}

/**
 * One card row of a SportLots `listcards.tpl` page, parsed. The shape
 * `fetchSportLotsChecklist` returns per card.
 */
export type SlListcardsCard = {
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
};

/**
 * What `walkSlListcards` answers: every row of the pages it read, or why a
 * page failed. A failure carries no partial rows: a truncated set is the bug
 * the pagination below exists to prevent.
 */
export type SlListcardsWalk =
  | {
      cards: SlListcardsCard[];
      pagesOk: number;
      slowestPageMs: number;
      /**
       * Set only when the walk stopped because it used up `maxPages` while
       * the last page still held new rows: the set may be longer than what
       * was read. Absent when the walk saw SportLots' end-of-set signal (an
       * empty page, or a page that did not advance).
       */
      truncated?: true;
    }
  | { failure: FetchFailure; message: string };

/**
 * Safety valve on the walk: bounds the loop if SL ever returns a non-empty
 * page forever. 200 pages = 20k listings, far beyond any real set. What
 * `fetchSportLotsChecklist` walks with.
 */
export const SL_MAX_PAGES = 200;

/**
 * NEO-325 — the `listcards.tpl` page loop, lifted out of
 * `fetchSportLotsChecklist` so a probe can read a set's first page (or count
 * it) with the same parse and the same end-of-set rules. Reads at most
 * `opts.maxPages` pages; stops earlier on an empty page or a page that did not
 * advance. Never asks for the cookie itself: the caller reads it once, so a
 * batch costs one token read, not one per set.
 *
 * `opts.deadlineAt` (epoch ms, optional) is a wall-clock bound on the whole
 * walk: no page starts at or after it, and each page's own timeout is clamped
 * to what is left, so the walk cannot run past it by more than the abort
 * takes. Reaching it is a `timeout` failure carrying no rows, like any other
 * page failure.
 *
 * Throws only for something unexpected outside a page request (a parse bug);
 * every page-level failure is returned.
 */
export async function walkSlListcards(
  sessionCookie: string,
  setRadioId: string,
  opts: { maxPages: number; deadlineAt?: number },
): Promise<SlListcardsWalk> {
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
  const cards: SlListcardsCard[] = [];

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
  let start = 1;
  let lastPageFingerprint = "";
  // NEO-321 follow-up — where a failure landed, and how the pages timed.
  let pagesOk = 0;
  let slowestPageMs = 0;
  const pageFailure = (
    failure: Omit<FetchFailure, "pageStart" | "pagesOk">,
  ): FetchFailure => ({ ...failure, pageStart: start, pagesOk });

  // The caller's page budget (`SL_MAX_PAGES` for a checklist), never more.
  const maxPages = Number.isFinite(opts.maxPages)
    ? Math.max(1, Math.min(SL_MAX_PAGES, Math.floor(opts.maxPages)))
    : 1;
  // Cleared when the walk sees the end-of-set signal; still set after the
  // loop means `maxPages` ran out while SportLots was still returning rows.
  let endSeen = false;
  for (let page = 0; page < maxPages; page++) {
    // NEO-325 — the caller's wall-clock budget, checked before every page.
    let pageTimeoutMs = SL_FETCH_TIMEOUT_MS;
    if (opts.deadlineAt !== undefined) {
      const remainingMs = opts.deadlineAt - Date.now();
      if (!(remainingMs > 0)) {
        return {
          message: "SportLots probe ran out of time before this page",
          failure: pageFailure({ kind: "timeout", timedOut: true }),
        };
      }
      pageTimeoutMs = Math.max(1, Math.min(SL_FETCH_TIMEOUT_MS, Math.floor(remainingMs)));
    }
    const formData = new URLSearchParams({
      selset: setRadioId,
      dcond: "NM",
      dbin: "1",
      dval: "0.18",
      dentry: "ADD",
      pricing: "OLD",
      start: String(start),
    });

    // NEO-321 follow-up — a throw on THIS page (our 30s timer, or the
    // network) is answered here, with the page it hit, instead of falling
    // to the outer catch with no position. The message is unchanged.
    const pageStartedAt = Date.now();
    let response: Response;
    let html: string;
    try {
      response = await slFetch(
        LISTCARDS_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: sessionCookie,
          },
          body: formData.toString(),
        },
        pageTimeoutMs,
      );

      if (!response.ok) {
        await response.text().catch(() => "");
        // Fail the whole fetch rather than silently returning a partial
        // checklist — a truncated set is exactly the bug this loop fixes,
        // and committing one would persist missing cards.
        return {
          message: `SportLots HTTP error: ${response.status}`,
          failure: pageFailure({
            kind: "http_error",
            httpStatus: response.status,
            timedOut: false,
          }),
        };
      }

      // The body read is under the same abort timer as the request.
      html = await response.text();
    } catch (err) {
      const timedOut =
        err instanceof SlFetchTimeoutError || isAbortTimeout(err);
      return {
        message: `SportLots error: ${err instanceof Error ? err.message : "Unknown error"}`,
        failure: pageFailure(
          timedOut
            ? { kind: "timeout", timedOut: true, timeoutMs: pageTimeoutMs }
            : { kind: "network", timedOut: false },
        ),
      };
    }
    slowestPageMs = Math.max(slowestPageMs, Date.now() - pageStartedAt);

    if (isSessionExpired(html)) {
      return {
        message: "SportLots session expired. Re-authenticate from Profile.",
        failure: pageFailure({
          kind: "signed_out",
          httpStatus: response.status,
          timedOut: false,
        }),
      };
    }
    pagesOk++;

    // Collect this page separately so an unchanged page can be detected
    // and discarded BEFORE it contributes duplicates.
    const pageCards: typeof cards = [];
    cardRegex.lastIndex = 0;
    let match;

    while ((match = cardRegex.exec(html)) !== null) {
      const cardNumber = match[1].trim();
      // The description EXACTLY as SportLots served it. Never normalised,
      // never decoded — see the platformRef note below.
      const fullDescription = match[2].trim();

      if (!cardNumber || !fullDescription) continue;

      // NEO-251: decode SL's HTML entities ONCE, at the head of the
      // DERIVATION path only. Everything downstream of here — cardName,
      // attributes, the variation label, the player parse — sees the same
      // decoded text, so an apostrophe in "Peter O&#39;Brien" is a real
      // apostrophe in every derived field or in none.
      //
      // `fullDescription` itself deliberately stays raw. See platformRef.
      const decodedDescription = decodeSlEntities(fullDescription);

      // Strip a leading "#NNN" if the description echoes the card number,
      // then run the token tokenizer to lift attributes / print run.
      let working = decodedDescription;
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
      const cardName = residual || withoutVariation || decodedDescription;

      // NEO-251: player names off the same residual `cardName` is built
      // from. `cardName` itself is untouched — this only ADDS a field.
      // Returns `{}` (so `players` stays undefined) on any doubt; see
      // parseSlSubjects. `team`/`teams` are never set here, deliberately.
      const { players } = parseSlSubjects(residual);

      pageCards.push({
        cardNumber,
        cardName,
        players,
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
        //
        // NEO-251, THE REASON THIS IS `fullDescription` AND NOT THE
        // DECODED STRING: this ref is an IDENTITY KEY, not display text.
        // `buildCommitPrelude` matches stored rows on it byte-for-byte
        // (`existingIdBySlRef` in selectorOptions.ts), and
        // `fetchCardChecklist` warns about `orphanedSlRefs` for every
        // stored ref the fetch no longer returns. Decoding it would
        // change the key of every already-stored row whose description
        // contains an entity — each one would go orphaned AND be
        // re-inserted as a new card. A key is compared, never read, so it
        // gains nothing from decoding and loses the one property it
        // needs: stability. Decode for display; never for identity.
        platformRef: fullDescription,
        sportlotsRef: cardNumber,
      });
    }

    // An EMPTY page is the only reliable end-of-set signal — see above.
    // A short page is normal mid-set (88, 92, 89, 31 … all precede more
    // data), so breaking on one truncates the walk.
    if (pageCards.length === 0) {
      endSeen = true;
      break;
    }

    // Defence against a `start` that does not advance. If SL ever ignores
    // the offset and re-serves the same page, appending would duplicate
    // every row and the walk would only stop at SL_MAX_PAGES — 200 live
    // requests. Comparing the page's identity fingerprint stops it at two.
    const fingerprint = `${pageCards.length}|${pageCards[0].cardNumber}|${pageCards[0].platformRef}`;
    if (fingerprint === lastPageFingerprint) {
      endSeen = true;
      break;
    }
    lastPageFingerprint = fingerprint;

    cards.push(...pageCards);
    start += SL_PAGE_STRIDE;
  }

  return endSeen
    ? { cards, pagesOk, slowestPageMs }
    : { cards, pagesOk, slowestPageMs, truncated: true };
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
    // NEO-321 follow-up — why the fetch failed, beside `success: false`
    // (which page, how many before it succeeded). Diagnostic only: no URL,
    // cookie or marketplace string.
    failure: v.optional(fetchFailureValidator),
    // Page requests sent (the empty end-of-set page included) and the slowest
    // one's time — on success, for the caller's timing log.
    pages: v.optional(v.number()),
    slowestPageMs: v.optional(v.number()),
  }),
  handler: async (ctx, args) => {
    await requireAdmin(ctx);

    // NEO-287 — paused: refuse BEFORE `getSportLotsCookie`, so no token read,
    // no refresh and no stored-session login happens. `fetchCardChecklist`
    // already skips the SportLots side via `resolvableSides`; this is the
    // adapter's own backstop. `success: false` with no cards — a paused side
    // was not asked, and the caller must not read its silence as an empty set.
    if (isPlatformPaused("sportlots")) {
      await recordAdapterCall(ctx, {
        requestId: newRequestId(),
        operation: "fetchSportLotsChecklist",
        platform: "sportlots",
        parentSport: args.parentFilters.sport,
        parentYear: args.parentFilters.year,
        parentSetName: args.parentFilters.setName,
        duration_ms: 0,
        success: false,
        result_count: 0,
        stage: "adapter",
        error_class: "paused",
      });
      return {
        success: false,
        cards: [],
        message: pausedSyncMessage(["sportlots"]),
        failure: { kind: "refused" as const, timedOut: false },
      };
    }

    try {
      const sessionCookie = await getSportLotsCookie(ctx);
      if (!sessionCookie) {
        return {
          success: false,
          cards: [],
          message: "No SportLots session cookie. Re-authenticate from Profile.",
          failure: { kind: "no_sign_in" as const, timedOut: false },
        };
      }

      // The set's SportLots radio id (`selset`), from the caller's
      // slot-derived `platformFilters` ONLY (NEO-91, NEO-239, NEO-256). SL
      // combines set+variant into one list, so the id usually sits on
      // variantType/insert/parallel; deepest level wins, matching
      // fetchCardChecklist's own precedence in selectorOptions.ts. No id means
      // no request: a set name is never sent as an id and never looked up.
      const setRadioId =
        args.platformFilters?.parallel
        || args.platformFilters?.insert
        || args.platformFilters?.variantType
        || args.platformFilters?.setName
        || "";

      if (!setRadioId) {
        return {
          success: false,
          cards: [],
          message: SL_UNSCOPED_MESSAGE,
          failure: { kind: "refused" as const, timedOut: false },
        };
      }

      const walked = await walkSlListcards(sessionCookie, setRadioId, {
        maxPages: SL_MAX_PAGES,
      });
      if ("failure" in walked) {
        return {
          success: false,
          cards: [],
          message: walked.message,
          failure: walked.failure,
        };
      }
      const { cards } = walked;

      return {
        success: true,
        cards,
        message: `Found ${cards.length} cards from SportLots`,
        pages: walked.pagesOk,
        slowestPageMs: walked.slowestPageMs,
      };
    } catch (error) {
      console.error("[fetchSportLotsChecklist] Error:", error);
      return {
        success: false,
        cards: [],
        message: `SportLots error: ${error instanceof Error ? error.message : "Unknown error"}`,
        failure:
          error instanceof SlFetchTimeoutError || isAbortTimeout(error)
            ? { kind: "timeout" as const, timedOut: true, timeoutMs: SL_FETCH_TIMEOUT_MS }
            : { kind: "unknown" as const, timedOut: false },
      };
    }
  },
});

/**
 * NEO-325 — the Base match probe's SportLots half: read the session cookie
 * ONCE for the whole batch, then walk each set id (one page, or the whole set,
 * `SL_PROBE_CONCURRENCY` sets at a time) and answer a summary per id: the
 * first non-variation row, the row counts and the pages read. Never the rows.
 *
 * One cookie read per batch matters: the browser service's token endpoint is
 * rate-limited per credential key, so a read per id would spend that budget
 * on a single dialog.
 *
 * Bounded in wall-clock and pages (`SL_PROBE_DEADLINE_MS` for the whole call
 * from the first walk; `SL_PROBE_COUNT_MAX_PAGES` per id in `count` mode). A
 * `count` walk that used up its pages while the set was still returning rows
 * is `failed` / `timeout`, never a count: a truncated walk's count is wrong.
 *
 * Writes no catalog row; the cookie read may update credential status, as
 * every SportLots fetch's does. Never throws for a fetch: every failure is a
 * per-id `failed` with the walk's `kind`. Reached only through
 * `baseMatchProbe.probeSlFirstPage` / `probeSlCount`, which validate and cap
 * the ids first; checked again here because this action trusts nothing.
 */
export const probeSlListcardsBatch = internalAction({
  args: {
    setIds: v.array(v.string()),
    /** `firstPage`: one page per set. `count`: the whole set (`SL_PROBE_COUNT_MAX_PAGES`). */
    mode: v.union(v.literal("firstPage"), v.literal("count")),
  },
  returns: v.array(slListcardsSummaryValidator),
  handler: async (ctx, args): Promise<SlListcardsSummary[]> => {
    await requireAdmin(ctx);
    const setIds = checkProbeIds(args.setIds, {
      max: args.mode === "firstPage" ? MAX_SL_FIRST_PAGE_IDS : MAX_SL_COUNT_IDS,
      maxLength: MAX_SL_PROBE_ID_LENGTH,
      pattern: SL_PROBE_ID_PATTERN,
    });
    const maxPages = args.mode === "firstPage" ? 1 : SL_PROBE_COUNT_MAX_PAGES;
    const startedAt = Date.now();
    const operation =
      args.mode === "firstPage" ? "probe_first_page" : "probe_count";
    const allFailed = (
      kind: "refused" | "no_sign_in" | "unknown",
    ): SlListcardsSummary[] =>
      setIds.map((id) => ({ id, status: "failed" as const, kind }));
    const log = (results: SlListcardsSummary[], outcome: string) =>
      console.log(
        JSON.stringify({
          msg: "base_match_probe",
          platform: "sportlots",
          operation,
          outcome,
          ids: setIds.length,
          ok: results.filter((r) => r.status === "ok").length,
          failed: results.filter((r) => r.status === "failed").length,
          durationMs: Date.now() - startedAt,
        }),
      );

    if (setIds.length === 0) return [];

    // NEO-287 — paused: refuse BEFORE the cookie is asked for, exactly as
    // `fetchSportLotsChecklist` does.
    if (isPlatformPaused("sportlots")) {
      const results = allFailed("refused");
      log(results, "paused");
      return results;
    }

    let sessionCookie: string | null;
    try {
      sessionCookie = await getSportLotsCookie(ctx);
    } catch {
      const results = allFailed("unknown");
      log(results, "cookie_read_failed");
      return results;
    }
    if (!sessionCookie) {
      const results = allFailed("no_sign_in");
      log(results, "no_cookie");
      return results;
    }
    const cookie = sessionCookie;
    // One budget for the whole call, from the first walk: an id the budget
    // does not reach fails `timeout` without a request.
    const deadlineAt = Date.now() + SL_PROBE_DEADLINE_MS;

    const results = await mapWithConcurrency(
      setIds,
      SL_PROBE_CONCURRENCY,
      async (id): Promise<SlListcardsSummary> => {
        try {
          const walked = await walkSlListcards(cookie, id, { maxPages, deadlineAt });
          if ("failure" in walked) {
            return { id, status: "failed", kind: walked.failure.kind };
          }
          // `firstPage` reads one page by design; only a count needs the end.
          if (args.mode === "count" && walked.truncated) {
            return { id, status: "failed", kind: "timeout" };
          }
          const summary = summarizeProbeCards(walked.cards);
          return { id, status: "ok", ...summary, pages: walked.pagesOk };
        } catch (err) {
          return {
            id,
            status: "failed",
            kind:
              err instanceof SlFetchTimeoutError || isAbortTimeout(err)
                ? "timeout"
                : "unknown",
          };
        }
      },
    );
    log(results, "done");
    return results;
  },
});
