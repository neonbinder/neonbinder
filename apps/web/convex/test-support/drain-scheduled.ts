/**
 * NEO-220 — drain a convex-test instance's scheduled functions before the test
 * ends.
 *
 * ## The failure this exists to prevent
 *
 * `convex-test` starts a scheduled function in the background as soon as it is
 * scheduled; it does NOT wait for it. A test that schedules work and then
 * returns leaves that work running into the worker's teardown, and when the
 * function logs (every one of ours does, on success or failure) the console-log
 * RPC races the worker shutdown:
 *
 *   Unhandled Rejection — EnvironmentTeardownError: [vitest-worker]:
 *   Closing rpc while onUserConsoleLog was pending
 *
 * preceded by `Cannot load '/convex/<some module>.ts'`, because the module
 * loader is already gone by the time the scheduled function reaches for its
 * dependencies. It fails the JOB while every test reports green, and it is
 * timing-dependent — it reproduces in CI and not on a dev laptop, which is the
 * worst shape a failure can have.
 *
 * NEO-220 made this reachable from far more tests by giving
 * `players.findOrCreate` a `wikidataPool.enqueueEnrichment` on its insert
 * branch: any test that creates a player through it now schedules work, and
 * `convex/previewListingTitle.test.ts` — which only wanted a player row to
 * exist — was the file CI caught.
 *
 * ## Why the `advanceTimers` argument is a no-op here
 *
 * The established pattern in this suite is
 * `finishAllScheduledFunctions(vi.runAllTimers)` under `vi.useFakeTimers()`,
 * and that stays correct for tests that are ABOUT scheduling (see
 * `backfillCardFeatures.test.ts`, `placeholderPairing.incremental.test.ts`) —
 * they need to advance a clock to make a delayed function fire.
 *
 * These callers are not about scheduling. They create a player as a FIXTURE
 * and want the incidental enrichment to settle, and every one of those is a
 * `runAfter(0)`, whose real-clock time has already passed. `convex-test` drains
 * exactly those without any clock movement (see its own doc comment on
 * `finishAllScheduledFunctions`), so passing a no-op lets a test file keep real
 * timers. That matters: retrofitting `vi.useFakeTimers()` onto a large existing
 * file changes the behaviour of every OTHER test in it, which is a much bigger
 * blast radius than the bug being fixed.
 *
 * `finishAllScheduledFunctions` rather than `finishInProgressScheduledFunctions`
 * because it loops until nothing is left — a function that has been scheduled
 * but has not yet reached the `inProgress` state is exactly the one that races
 * teardown, and only the looping form waits for it.
 *
 * ## What it does NOT do
 *
 * It does not assert anything about the drained work, and it must not be used
 * to make a test pass. Tests that assert ON the scheduler (
 * `enrichmentCreationOnly.test.ts` counting `_scheduled_functions` rows) read
 * the queue first and drain afterwards; draining does not disturb the rows they
 * already read. The suite's network guard
 * (`vitest.setup.network-guard.ts`) still turns any real outbound request into
 * a failed run, so a drained enrichment cannot reach Wikidata — it fails inside
 * the scheduled function, which is logged and ignored, and is precisely the
 * behaviour we want happening BEFORE teardown rather than during it.
 */
export async function drainScheduled(t: {
  finishAllScheduledFunctions: (advanceTimers: () => void) => Promise<void>;
}): Promise<void> {
  await t.finishAllScheduledFunctions(() => {});
}

/**
 * NEO-220 — CANCEL every pending scheduled function instead of running it.
 *
 * The counterpart to `drainScheduled`, for work that is scheduled with a real
 * DELAY. `finishAllScheduledFunctions` can only force a function whose
 * scheduled time has already passed on the real clock; a delayed one is
 * skipped, so draining does not remove it and it stays armed to fire during
 * teardown. The alternative — retrofitting `vi.useFakeTimers()` onto the whole
 * file so `vi.runAllTimers` can reach it — changes time semantics for every
 * other test in that file, which is a far bigger blast radius than the leak.
 *
 * Cancelling is the honest description of what these tests want. The concrete
 * case is `placeholderEscalation.test.ts`: completing an image schedules
 * `placeholderPairing:runPairing` behind a 5s debounce
 * (`PAIRING_DEBOUNCE_MS`), and nothing in that file asserts on pairing — it
 * covers escalation state. Locally the file finishes well inside 5s and the
 * timer never fires; in CI it does not, which is why the failure is
 * CI-only. Cancelling says "this file does not exercise the debounced pairing
 * run" rather than pretending to run it.
 *
 * Use `drainScheduled` whenever the work is `runAfter(0)` — actually settling
 * it is always preferable to discarding it. Reach for this only when the delay
 * makes that impossible.
 */
export async function cancelScheduled(t: {
  run: <T>(fn: (ctx: never) => Promise<T>) => Promise<T>;
}): Promise<void> {
  await t.run(async (ctx: never) => {
    const c = ctx as unknown as {
      db: {
        system: {
          query: (n: string) => {
            collect: () => Promise<Array<{ _id: unknown; state: { kind: string } }>>;
          };
        };
      };
      scheduler: { cancel: (id: never) => Promise<void> };
    };
    const rows = await c.db.system.query("_scheduled_functions").collect();
    for (const row of rows) {
      // Only what has not started. A finished or in-progress function is not
      // cancellable, and an in-progress one is already being awaited by
      // whatever started it.
      if (row.state.kind === "pending") {
        await c.scheduler.cancel(row._id as never);
      }
    }
  });
}
