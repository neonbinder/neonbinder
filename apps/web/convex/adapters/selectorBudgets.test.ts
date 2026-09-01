/**
 * NEO-198 — the aggregator's per-child deadline must never sit below the
 * ceiling of the adapter it is supposed to contain.
 *
 * The bug this pins was not a wrong number, it was a number with no owner:
 * `SL_CHILD_DEADLINE_MS = 12_000` lived in selectorOptions.ts, justified by a
 * comment reading "the child's own retry ceiling + margin (SL ≈ 9s)", while the
 * retry policy it claimed to describe lived in adapters/sportlots.ts. The 9s
 * counted `SL_SELECTOR_FETCH_TIMEOUT_MS × SL_SELECTOR_FETCH_MAX_ATTEMPTS` and
 * silently omitted the empty-result recovery loop — two further rounds of
 * (500ms settle + one 3s re-POST) that run inside the same budget. Real ceiling
 * 16s, deadline 12s: `fetchAggregatedOptions` could abandon a SportLots child
 * that was still executing its own documented retry policy and record the
 * result as a hang.
 *
 * Both halves now derive from convex/adapters/selectorBudgets.ts, so they
 * cannot part ways by accident. These tests are the guard against someone
 * re-hardcoding either half, and against the ceiling drifting out of step with
 * the constants it is computed from.
 *
 * NOT covered here, deliberately: the credential path. `getSportLotsCookie` →
 * `getSiteToken` → `readCachedToken` (15s browser fetch) and the recovery
 * loop's `authenticateSportlots` → `loginWithRetry` (4 × 60s) are minutes of
 * nested work that no `ceilingMs` bounds. See the module header for why NEO-198
 * leaves that alone and attributes it with a phase breadcrumb instead.
 */

import { describe, expect, test } from "vitest";
import {
  SL_SELECTOR_BUDGET,
  BSC_SELECTOR_BUDGET,
  CHILD_DEADLINE_MARGIN_MS,
} from "./selectorBudgets";
import { CHILD_DEADLINES_MS, childDeadlineMessage } from "../selectorOptions";

describe("adapter self-bounded ceilings", () => {
  test("SportLots' ceiling counts the empty-result recovery loop, not just the initial attempts", () => {
    // Recomputed from the policy independently of how selectorBudgets.ts
    // spells it: `slSelectorFetchWithRetry` runs maxAttempts back-to-back
    // attempts with NO inter-attempt backoff, and the empty-result loop then
    // runs (maxAttempts - 1) further rounds, each a settle sleep plus one more
    // full-timeout re-POST.
    const initial =
      SL_SELECTOR_BUDGET.perAttemptTimeoutMs * SL_SELECTOR_BUDGET.maxAttempts;
    const recovery =
      (SL_SELECTOR_BUDGET.maxAttempts - 1) *
      (SL_SELECTOR_BUDGET.emptyRetryBackoffMs +
        SL_SELECTOR_BUDGET.perAttemptTimeoutMs);

    expect(SL_SELECTOR_BUDGET.ceilingMs).toBe(initial + recovery);
    // The number the old comment should have said. Spelled out so a change to
    // the retry policy is a deliberate edit here, not a silent widening.
    expect(SL_SELECTOR_BUDGET.ceilingMs).toBe(16_000);
    // And explicitly: it is NOT the 9s the pre-NEO-198 comment claimed.
    expect(SL_SELECTOR_BUDGET.ceilingMs).toBeGreaterThan(initial);
  });

  test("BSC's ceiling counts its inter-attempt backoffs", () => {
    const expected =
      BSC_SELECTOR_BUDGET.perAttemptTimeoutMs * BSC_SELECTOR_BUDGET.maxAttempts +
      BSC_SELECTOR_BUDGET.backoffMs.reduce((sum, ms) => sum + ms, 0);

    expect(BSC_SELECTOR_BUDGET.ceilingMs).toBe(expected);
    expect(BSC_SELECTOR_BUDGET.ceilingMs).toBe(31_500);
    // The backoff list must stay one shorter than the attempt count — there is
    // no sleep after the final attempt.
    expect(BSC_SELECTOR_BUDGET.backoffMs).toHaveLength(
      BSC_SELECTOR_BUDGET.maxAttempts - 1,
    );
  });
});

describe("aggregator child deadlines", () => {
  // THE regression guard. Reverting SL_CHILD_DEADLINE_MS to the old literal
  // 12_000 fails this case and only this pair of cases.
  test("every child deadline is at least its adapter's own ceiling", () => {
    expect(CHILD_DEADLINES_MS.sportlots).toBeGreaterThanOrEqual(
      SL_SELECTOR_BUDGET.ceilingMs,
    );
    expect(CHILD_DEADLINES_MS.bsc).toBeGreaterThanOrEqual(
      BSC_SELECTOR_BUDGET.ceilingMs,
    );
  });

  test("each deadline is exactly its ceiling plus the shared margin", () => {
    expect(CHILD_DEADLINES_MS.sportlots).toBe(
      SL_SELECTOR_BUDGET.ceilingMs + CHILD_DEADLINE_MARGIN_MS,
    );
    expect(CHILD_DEADLINES_MS.bsc).toBe(
      BSC_SELECTOR_BUDGET.ceilingMs + CHILD_DEADLINE_MARGIN_MS,
    );
  });

  test("BSC's deadline is unchanged by the NEO-198 derivation", () => {
    // The derivation was applied to BSC too, but it must reproduce the value
    // BSC has always run with. If this goes red, the change stopped being a
    // no-op for BSC and needs to be called out as a behaviour change.
    expect(CHILD_DEADLINES_MS.bsc).toBe(35_000);
  });

  test("SportLots' deadline is the derived 19_500, the documented behaviour change", () => {
    expect(CHILD_DEADLINES_MS.sportlots).toBe(19_500);
  });

  test("no deadline can outlast the front-end's give-up backstop", () => {
    // components/SetSelector/useSelectorSync.ts arms SELECTOR_SYNC_FE_TIMEOUT_MS
    // = 38_000. A child deadline above it means the column shows its error and
    // stops listening before the backend can report which platform stalled —
    // the whole reason the deadlines exist. Not imported: that module pulls in
    // react + posthog-js and this suite runs under edge-runtime.
    const SELECTOR_SYNC_FE_TIMEOUT_MS = 38_000;
    for (const ms of Object.values(CHILD_DEADLINES_MS)) {
      expect(ms).toBeLessThan(SELECTOR_SYNC_FE_TIMEOUT_MS);
    }
  });
});

describe("childDeadlineMessage", () => {
  const msg = childDeadlineMessage("SportLots", 19_500, "req-abc");

  test("states the fact a fired deadline actually establishes", () => {
    expect(msg).toContain("SportLots");
    expect(msg).toContain("19.5s");
    expect(msg).toContain("did not return");
  });

  test("does NOT claim to know where the time went", () => {
    // The pre-NEO-198 wording. A deadline that fires gets no return value, so
    // the aggregator has no token_ms / filters_call_ms and cannot locate the
    // stall — asserting it did was the bug.
    expect(msg).not.toMatch(/stalled before/i);
    expect(msg).not.toMatch(/within the marketplace fetch/i);
    expect(msg).not.toMatch(/no response/i);
    // It must positively disclaim the attribution rather than just omit it,
    // so the next reader doesn't re-add a guess.
    expect(msg).toMatch(/not visible from here/i);
  });

  test("carries the correlation id, which is how the phase IS attributable", () => {
    // adapter_phase(token_ready) is emitted by the child before it can hang;
    // joining on this requestId is what separates auth from fetch.
    expect(msg).toContain("req-abc");
  });

  test("is platform-agnostic — BSC gets the same honest shape", () => {
    const bsc = childDeadlineMessage("BSC", 35_000, "req-xyz");
    expect(bsc).toContain("BSC");
    expect(bsc).toContain("35s");
    expect(bsc).not.toMatch(/stalled before/i);
    expect(bsc).toMatch(/not visible from here/i);
  });
});
