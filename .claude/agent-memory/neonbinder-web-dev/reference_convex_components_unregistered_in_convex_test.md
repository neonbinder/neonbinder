---
name: convex-components-unregistered-in-convex-test
description: No test in apps/web calls t.registerComponent, so draining any schedule that reaches a component (wikidataPool, workpool) swaps EnvironmentTeardownError for "Component X is not registered" — cancel the job instead
metadata:
  type: reference
---

`apps/web` has **zero** `t.registerComponent` calls. Any scheduled function
that touches a Convex component — `wikidataPool:enqueueEnrichment` is the one
that bites, via `@convex-dev/workpool` — therefore CANNOT be run under
convex-test. `finishAllScheduledFunctions` will execute it and it will throw
`Component "wikidataPool" is not registered. Call "t.registerComponent"`,
printed by convex-test exactly like the teardown error you were trying to
remove.

**How to own such a job instead of draining it:** cancel it in `afterEach` off
the system table, and assert the *enqueue* rather than the execution.

```ts
await t.run(async (ctx) => {
  for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
    if (job.state.kind === "pending" || job.state.kind === "inProgress") {
      await ctx.scheduler.cancel(job._id);
    }
  }
});
```

`ctx.db.system.query("_scheduled_functions")` works in `t.run`, `job.name` is
`"module:function"`, and `job.args` is an **array** of the arg objects — so the
wire assertion is `expect(jobs[0].args).toEqual([{ leagueIds: [id] }])`.
convex-test honours `cancel` (it checks `state.kind === "canceled"` immediately
before invoking), so a cancelled job never fires at teardown.

`finishAllScheduledFunctions` also takes no `maxIterations` argument despite
what its own error message says, and its ceiling is low — a self-chaining queue
seeded with many rows (the 1200-card cursor test in
`cardChecklist.bscTeamEnrichment.test.ts`) can never be drained.

Related: [[transient-parse-errors-are-hardware]], [[vitest-throwing-console-spy]].

A mutation that enqueues directly (not through a schedule) throws the same error at the call. `vi.spyOn(pool, "enqueueAction").mockResolvedValue("work" as never)` in `beforeEach` stands in, and its `mock.calls` assert the enqueue really happened (NEO-427); restore in `afterEach`.

**When MANY tests in a file trigger the schedule** (e.g. every armed run of
`resetSetBuilderDataFromCli` schedules `bscTeamPool:cancelAllBscTeamChecks`):
convex-test fires scheduled jobs on `globalThis.setTimeout` (fake-timer aware),
so a file-level `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })`
keeps every such job pending without faking `Date` (budget tests still read the
real clock). To prove the job itself, `vi.spyOn(pool, "cancelAll")` (or the
method the job calls) then `await t.finishAllScheduledFunctions(vi.runAllTimers)`.
Restore with `vi.useRealTimers()` + `vi.restoreAllMocks()` in `afterEach`.
