/**
 * NEO-188: no unit test may reach the network.
 *
 * `convex/featurePropagation.test.ts` was calling the LIVE BuySportsCards
 * production API on every `npm run test:unit`, from a scheduled enrichment
 * chain a test kicked off and never drained. It surfaced only as an
 * `Errors 1 error` line in the summary — the rejection landed after the
 * test that caused it had finished — so the suite stayed "green" while a
 * partner's prod API took traffic from every dev machine and every CI run.
 *
 * This installs a `fetch` that refuses to make the call and RECORDS it.
 * Recording is the load-bearing half: production code legitimately catches
 * its own fetch errors (`fetchBscCardTeamNameRaw` returns `{success:false}`
 * on throw), so a guard that only threw would be swallowed by the code under
 * test and change nothing. The recorded violation is re-thrown from
 * `afterEach`/`afterAll`, where nothing can catch it.
 *
 * A test that MEANS to exercise fetch stubs it as usual:
 *
 *     vi.stubGlobal("fetch", (async (url) => new Response("{}")) as typeof fetch);
 *
 * `vi.unstubAllGlobals()` then restores this guard, not the real `fetch`.
 *
 * ## NEO-247 — the afterAll settle, and why it exists
 *
 * A leak that comes from an undrained `runAfter(0)` scheduled function does
 * not fire in the SAME tick the triggering test returns in — convex-test's
 * scheduler runs it on a later tick of the real event loop. An immediate,
 * no-delay check (which is what `afterEach` still is, below) can genuinely
 * run BEFORE that tick and see an empty `violations` array — not because
 * nothing leaked, but because the check looked too early. That is exactly
 * how NEO-247 found ~63 blocked-request lines that never failed a single
 * test: every one of them was checked-for too soon and silently dropped.
 *
 * `afterAll`'s settle closes that gap the cheap way: it runs once per FILE
 * (not once per test), so a short real-clock wait here is affordable in a
 * way it would not be in `afterEach`. It cannot promise to catch a function
 * scheduled with a real multi-second delay — that class of leak is what
 * `cancelScheduled` (`lib/testing/drain-scheduled.ts`) exists for, at the
 * test that creates it — but it reliably closes the `runAfter(0)` gap that
 * caused NEO-247, without slowing the common (nothing leaked) case by more
 * than this file's own single wait.
 */
import { afterAll, afterEach, beforeEach } from "vitest";

type Violation = { url: string; testName: string };

const violations: Violation[] = [];
let currentTestName = "<outside a test>";

/** Best-effort URL extraction — `fetch` accepts string | URL | Request. */
function describeTarget(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (typeof input === "object" && input !== null && "url" in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

const guardedFetch = (async (input: unknown) => {
  const url = describeTarget(input);
  violations.push({ url, testName: currentTestName });
  // Thrown for the benefit of tests whose code does NOT catch — they fail at
  // the call site, which is the most useful place. Code that catches is
  // covered by the afterEach/afterAll re-throw below.
  throw new Error(
    `NEO-188: blocked a real outbound request to ${url}\n` +
      `Unit tests must not touch the network. Stub it:\n` +
      `  vi.stubGlobal("fetch", (async () => new Response("{}")) as typeof fetch)\n` +
      `If this came from a Convex scheduled function, the test also needs to ` +
      `drain it: await t.finishAllScheduledFunctions(vi.runAllTimers)`,
  );
}) as unknown as typeof fetch;

globalThis.fetch = guardedFetch;

beforeEach((ctx) => {
  currentTestName = ctx.task.name;
});

function flushViolations(phase: string) {
  if (violations.length === 0) return;
  const seen = violations.splice(0, violations.length);
  const lines = seen.map((v) => `  - ${v.url}  (from: ${v.testName})`).join("\n");
  throw new Error(
    `NEO-188: ${seen.length} real outbound request(s) attempted during ${phase}:\n${lines}\n` +
      `A request recorded here was swallowed by a try/catch in the code under ` +
      `test, so it could not fail at the call site. Stub fetch, and drain any ` +
      `scheduled functions the test starts.`,
  );
}

/**
 * Give an undrained `runAfter(0)` scheduled function one real-clock window to
 * actually fire before the file-level check below runs — see the class
 * comment above. 30ms was the smallest value that caught every known
 * NEO-247 leak reliably across repeated runs; it is spent once per FILE, not
 * once per test, which is what keeps it affordable.
 */
async function settleBeforeFileCheck() {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

afterEach(() => {
  flushViolations("this test");
});
// Catches anything that escaped teardown — the original NEO-188 shape, where
// the request lands after the test that started it has already finished.
afterAll(async () => {
  await settleBeforeFileCheck();
  flushViolations("this file, after its tests finished");
});
