---
name: project_convex_test_patterns
description: convex-test patterns confirmed working in this repo — calling internal functions directly, spying on structured console.log lines, and simulating stale/concurrent state via direct db.patch
metadata:
  type: project
---

Patterns confirmed against `convex-test` (v4 vitest + `convex-test` package) in
`apps/web/convex/`, useful whenever a test needs to exercise something the
public `api.*` surface doesn't expose directly.

- **Calling an `internalMutation`/`internalAction` directly**: `t.mutation(internal.teams.applyEnrichmentInternal, {...})` and `t.action(internal.teamColorSources.resolveTeamColors, {...})` both work exactly like their `api.*` counterparts — no special setup. Precedent: `convex/leagues.test.ts`, `convex/teamColorSourcesResolve.test.ts`. Useful for unit-testing one internal mutation's logic (e.g. a gap-fill rule) without going through the network-backed action that normally calls it.
- **Asserting a structured `console.log(JSON.stringify(...))` line**: `vi.spyOn(console, "log").mockImplementation((...args) => logs.push(args.map(String).join(" ")))`, then filter `logs` for the `"msg":"<name>"` substring and `JSON.parse` it. Precedent: `convex/adapterPhase.test.ts`. Needed when a value (e.g. `selectorOptions.ts`'s `ambiguousMatchKeys`) is deliberately NOT returned to the client and only reaches a log line — restore with `spy.mockRestore()`.
- **Simulating "the row moved since the diff was computed"** (stale `baseVersion`/OCC-shaped checks): don't rely on two real `Date.now()` calls being different — millisecond resolution makes that flaky under fast CI. Instead capture the value, then `t.run(ctx => ctx.db.patch(id, { lastUpdated: v1 + 1000 }))` to deterministically advance it.
- **Distinguishing "field re-diffed as unchanged, so untouched" from "field written with the same value"**: when a mutation treats `undefined` and `[]` (or similar) as equal via a semantic comparison (see `sameContentValue` in `selectorOptions.ts`), the two states aren't otherwise distinguishable from final DB state alone if you use a field whose "same" and "different" values look the same. Use a field whose stored representation would visibly change if the equality check were naive (e.g. assert `attributes` stays `undefined` rather than becoming `[]`) — that's an observable proxy for "the server actually re-diffed rather than trusting the caller."

Full matrix this produced: `apps/web/convex/commitCardChecklist.resync.test.ts`, `commitCardChecklist.operatorDecisions.test.ts`, plus extensions to `commitCardChecklist.chunking.test.ts`, `teamColorSourcesResolve.test.ts`, and a new `teams.applyEnrichmentInternal.test.ts` (NEO-203, 2026-09-01).
