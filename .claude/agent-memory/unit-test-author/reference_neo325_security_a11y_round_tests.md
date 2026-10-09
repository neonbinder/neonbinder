---
name: neo325-security-a11y-round-tests
description: NEO-325 security + a11y round tests - real refresh path under a stubbed login, Date.now skew for deadlines, status-region filter, same-id-twice-mapped fixture, equivalent mutants
metadata:
  type: reference
---

Files: `convex/baseMatchProbe.reauth.test.ts`, `baseMatchProbe.slBounds.test.ts`, `sportlots.selectorReauth.test.ts` (+ additions to `baseMatchProbe.test.ts`, `sportlots.walk.test.ts`); client `base-match-probe.stop.test.tsx`, `ReconciliationModal.baseMatchA11y.test.tsx`.

- Re-auth guards: `vi.mock("./credentials")` spreads the real module and replaces ONLY `getSiteToken` + `authenticateBsc`/`authenticateSportlots` (counters, async hook). The real `refreshSiteTokenAfterRejection`/backoff/lock then run in convex-test; seed `userProfiles.siteCredentials[]` (`needsReauth`+`reauthObservedAt`, or `lockedAt/lockedOp/lockToken`) to drive them. Limiter lines are `console.warn` JSON `msg: marketplace_limiter`.
- Deadlines without waiting: `vi.spyOn(Date, "now")` returning real + a skew variable that the fetch/login stub bumps. Concurrency-worker order is deterministic (each worker runs synchronously to its first fetch), so "exactly N requests before the budget is gone" is exact. A hanging fetch is tested for real with a ~120ms deadline and a stub that rejects on `init.signal` abort.
- An internal action that must throw: wrap the registry loader (`"./credentials.ts": async () => ({...real, fn: internalAction(...)})`).
- The userProfiles lock is allowed to write (F2): compare that table apart, with lock fields stripped.
- Status regions in the Reconcile dialog: dnd-kit's `DndLiveRegion-*` and the footer save notice are always there; "our" line is the other `role=status`.
- Same marketplace id both Pending and "already mapped" is not constructible from initialData (the reducer drops it); get there by mapping it twice, then DETACH from one set. Close the set-aside toggle first so the returned row is hidden.
- Equivalent / two-layer mutants (report, do not chase): public-action `pattern:` removal is masked by the internal action's own check; `pump` skip of a stopped side is masked by settling queued rows; `announcement: phase==="on"?...` is masked by the cleanup reset (only both together go red); `/^\d+$/` vs `/^[0-9]+$/` is identical in JS.
- Typecheck of tests: temp tsconfig extending `tsconfig.json` with an `include` list; `ctx.db.query("userProfiles")` rows in `t.run` need explicit param types.
