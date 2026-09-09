---
name: reference-fetchcardchecklist-multi-adapter-mock-pattern
description: How to integration-test fetchCardChecklist's (convex/selectorOptions.ts) wiring into BSC/SL adapters without real credentials/network — vi.mock both adapter modules + vi.hoisted mutable fixtures.
metadata:
  type: reference
---

## The problem

`fetchCardChecklist` (convex/selectorOptions.ts) fans out to BOTH
`api.adapters.buysportscards.fetchBscChecklist` AND
`api.adapters.sportlots.fetchSportLotsChecklist` via `Promise.allSettled`
before reconciling. Both real adapters need marketplace credentials (BSC
bearer token via Secret Manager, SL session cookie) — not worth seeding
just to reach the reconciliation/wiring logic you actually want to test.
There was no prior test file for `fetchCardChecklist` at all (confirmed by
grep before writing — don't assume "it's probably tested somewhere").

## The fix: vi.mock both adapter modules, not raw fetch

Follow the module-replacement convention already established in
`convex/bscTeamEnrichmentQueue.tolerance.test.ts` (there: mocking
`resolveBscCardTeam` to force a throw), but apply it to the two upstream
marketplace-fetch actions themselves:

```ts
const mockState = vi.hoisted(() => ({
  bscCards: [] as BscCard[],
  slCards: [] as SlCard[],
  teamNamesResult: {} as Record<string, string>,
  teamLookupCalls: [] as string[][],
}));

vi.mock("./adapters/buysportscards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/buysportscards")>();
  const { action, internalAction } = await import("./_generated/server");
  const { v } = await import("convex/values");
  return {
    ...actual,
    fetchBscChecklist: action({ ...replace handler to return mockState.bscCards... }),
    fetchBscCardTeamNames: internalAction({ ...replace handler, records calls, returns mockState.teamNamesResult... }),
  };
});

vi.mock("./adapters/sportlots", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./adapters/sportlots")>();
  ...replace fetchSportLotsChecklist the same way, returning mockState.slCards...
});
```

Key details:
- `vi.mock` factories are hoisted above imports — mutable per-test
  fixtures MUST live behind `vi.hoisted(() => ({...}))`, not a plain
  module-scope `let`, or you get a TDZ/reference error.
- Reset every `mockState` field in `beforeEach` — it's shared module state
  across every test in the file.
- Because the mock replaces the WHOLE action handler, `requireAdmin(ctx)`
  inside the real `fetchBscChecklist`/`fetchSportLotsChecklist` is
  bypassed entirely — you still need `t.withIdentity(ADMIN_IDENTITY)` for
  the OUTER call though, since `fetchCardChecklist` itself calls
  `ctx.runQuery(api.selectorOptions.getAncestorChain, ...)` which DOES
  call `requireAdmin(ctx)` directly (unmocked).
- Mock `internal.adapters.buysportscards.fetchBscCardTeamNames` directly
  (per NEO-90 test brief) rather than mocking raw `fetch` a third time —
  this file targets `fetchCardChecklist`'s OWN wiring (what it does with
  the returned map), not `fetchBscCardTeamNames`'s internals (that's
  `convex/fetchBscCardTeamNames.test.ts`'s job, with real `vi.stubGlobal("fetch", ...)`
  mocking since that action has no further adapter fan-out to mock away).

## Fixture requirement: BSC_REQUIRED_LEVELS precondition

`fetchCardChecklist` hard-fails before ever reaching reconciliation unless
the ancestor chain's sport/year/setName levels all carry
`platformData.bsc`. The seed tree needs a real `sport -> year -> setName ->
variantType` chain (4 levels, not the 3-level `sport -> setName ->
variantType` shortcut used elsewhere in this codebase for tests that call
`commitCardChecklist` directly with pre-built cards) with `platformData:
{ bsc: "..." }` on sport/year/setName. `variantType` (the leaf id you pass
as `selectorOptionId`) doesn't need a BSC slug for this precondition.

See `apps/web/convex/fetchCardChecklistTeamLookup.test.ts` (written on the neo-71-74 branch)
for the full working pattern, and `convex/fetchBscCardTeamNames.test.ts`
for the sibling pure-adapter-level tests (concurrency-bound test: assert
`maxInFlight === 10` via a synchronous inFlight++ before an artificial
`setTimeout` delay — chunk.map's `.map()` synchronously launches every
call in a chunk up to its first `await`, so this is deterministic with
REAL timers, no `vi.useFakeTimers()` needed).

Related: [[reference_convextest_modules_glob_must_be_repo_root_of_convex_dir]]
