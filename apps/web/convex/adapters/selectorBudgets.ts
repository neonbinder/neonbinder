/**
 * NEO-198 — per-adapter self-bounded worst cases for a selector-options fetch,
 * and the aggregator child deadlines derived from them.
 *
 * These used to be facts each adapter kept privately (`SL_SELECTOR_FETCH_*` in
 * adapters/sportlots.ts, `BSC_FETCH_*` in adapters/buysportscards.ts) while the
 * aggregator's matching per-child deadline lived in selectorOptions.ts as a
 * hand-written literal justified by a comment. Nobody ever re-added the two, so
 * the SportLots deadline (12s) had drifted BELOW the SportLots adapter's own
 * ceiling (16s): `fetchAggregatedOptions` could abandon an adapter that was
 * still legitimately inside its own retry policy and record the result as a
 * hang. The numbers now have exactly ONE definition, imported both by the
 * adapter that enforces them and by the aggregator that budgets around them, so
 * they cannot drift apart again. `selectorBudgets.test.ts` pins the invariant.
 *
 * This module deliberately carries NO `"use node"` directive. Both adapters are
 * Node actions and the aggregator is not, and Convex will not let an isolate
 * module import a Node one — a plain shared module is the only shape that both
 * sides can read from.
 *
 * ── WHAT `ceilingMs` COVERS ──────────────────────────────────────────────────
 * Only the time the adapter itself bounds: its marketplace HTTP attempts and
 * the sleeps it schedules between them. Nothing else.
 *
 * ── WHAT IT DELIBERATELY DOES NOT COVER ──────────────────────────────────────
 * Both adapters begin by resolving a session token
 * (`getSportLotsCookie` / `getBscToken` → `internal.credentials.getSiteToken`),
 * and the SportLots empty-result recovery loop forces a re-auth between
 * attempts (`internal.credentials.authenticateSportlots`). Those paths are NOT
 * bounded by anything the caller can express:
 *
 *   - `readCachedToken` → `browserFetch` is capped at BROWSER_FETCH_TIMEOUT_MS
 *     (15s, convex/credentials.ts) and `getSiteToken` can make up to two of
 *     those around a refresh;
 *   - `refreshSiteToken` / `authenticateSportlots` → `runSiteLogin` →
 *     `loginWithRetry` is 4 attempts of `AbortSignal.timeout(60_000)` with
 *     5s/10s/15s backoffs between 503s — roughly 4½ minutes on its own.
 *
 * So the true worst case for a child is minutes, not seconds, and NO value of
 * `ceilingMs` would make the deadline "correct" in the sense of never firing
 * early. Folding those ceilings in was considered and rejected: it would put
 * the child deadlines at ~5 minutes, which defeats the deadline's entire
 * purpose (guaranteeing the aggregator reaches `recordAdapterCall` instead of
 * spinning "Syncing…" forever) without making anything more accurate. Bounding
 * the credential path itself was also considered and rejected for NEO-198 —
 * `cloud_run_min_instances = 1` in both dev and prod already removes the
 * browser-service cold start that motivated it, that path is shared with the
 * interactive credential flows, and the failure has never been observed.
 *
 * The honest statement is therefore: `ceilingMs` is the adapter's OWN ceiling,
 * the deadline is that plus a margin, and a child that blows the deadline was
 * *probably* stuck in auth — which is why the adapters emit a `token_ready`
 * phase breadcrumb (see `recordAdapterPhase` in convex/observability.ts) before
 * they can hang in the fetch, so "probably" can be resolved to a fact.
 */

/** SportLots' selector-options retry policy. Owned by adapters/sportlots.ts. */
export const SL_SELECTOR_BUDGET = {
  /** Per-attempt abort for one newinven.tpl POST. */
  perAttemptTimeoutMs: 3_000,
  /**
   * Attempts in `slSelectorFetchWithRetry`, and (separately) the bound on the
   * empty-result re-auth loop, which runs `maxAttempts - 1` extra rounds.
   */
  maxAttempts: 3,
  /** Settle-in sleep between a forced re-auth and the re-POST. */
  emptyRetryBackoffMs: 500,
  /**
   * The adapter's own worst case, derived from the three numbers above rather
   * than written down: 3s x 3 initial attempts (no inter-attempt backoff) plus
   * 2 empty-result recovery rounds of (500ms settle + one 3s re-POST).
   * = 16_000ms.
   */
  ceilingMs: 3_000 * 3 + (3 - 1) * (500 + 3_000),
} as const;

/** BuySportsCards' selector-filters retry policy. Owned by adapters/buysportscards.ts. */
export const BSC_SELECTOR_BUDGET = {
  /** Per-attempt abort for one /search/bulk-upload/filters POST. */
  perAttemptTimeoutMs: 10_000,
  /** 1 initial attempt + 2 retries. */
  maxAttempts: 3,
  /** Backoff between attempts: [1->2, 2->3]. Length is maxAttempts - 1. */
  backoffMs: [500, 1_000] as readonly number[],
  /** 10s x 3 attempts + 500ms + 1000ms of backoff = 31_500ms. */
  ceilingMs: 10_000 * 3 + 500 + 1_000,
} as const;

/**
 * Headroom added on top of an adapter's own ceiling to get the aggregator's
 * hard deadline for that child.
 *
 * It absorbs the things that ride inside a child call but are not the
 * marketplace fetch: the `requireAdmin` round trip, the DB lookups that resolve
 * platform slugs, HTML parsing, and the (awaited, PostHog-backed)
 * `recordAdapterCall` on the way out. Not the credential path — see the note
 * above; nothing here pretends to cover that.
 *
 * 3_500ms is the margin BSC has always run with (31.5s ceiling under a 35s
 * deadline) and it has never fired in practice, so it is the one value on this
 * page with production evidence behind it. Applying it uniformly keeps BSC's
 * deadline byte-identical at 35_000 and lifts SportLots from a hand-written
 * 12_000 to 19_500 — see BEHAVIOUR CHANGE in the aggregator.
 */
export const CHILD_DEADLINE_MARGIN_MS = 3_500;
