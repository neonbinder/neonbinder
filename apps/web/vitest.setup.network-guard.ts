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

afterEach(() => flushViolations("this test"));
// Catches anything that escaped teardown — the original NEO-188 shape, where
// the request lands after the test that started it has already finished.
afterAll(() => flushViolations("this file, after its tests finished"));
