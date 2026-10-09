---
name: neo325-base-match-probe-tests
description: NEO-325 Base match probe server tests - fixture traps (BSC row id dedupe, cardChecklist platformData, players sportId), double-layer pause backstop needing direct internal-action tests, batch break-check script
metadata:
  type: reference
---

Files: `convex/baseMatchProbe.test.ts`, `convex/sportlots.walk.test.ts` (walkSlListcards called directly; no ctx needed).

- Mock `./credentials` `getSiteToken` (counter per site, token null = signed out) and `authenticateBsc` (hook that rotates the token) with `vi.mock`; a 401 costs a second `getSiteToken` read (getBscToken re-read), so "one read per batch" excludes the refresh.
- BSC stub rows need unique `id`s: the adapter dedupes by `id`, so a VAR row and its plain twin sharing an id silently collapses to one row.
- Raw `cardChecklist` inserts need `platformData: {}`; `players` need `sportId` (a selectorOptions sport row).
- Pause guard exists in BOTH the public action and the internal adapter: removing either alone is unobservable through the public action. Pin each layer by calling `internal.adapters.*` directly.
- A refused/ok mix inside one `probeBscSets` call is unreachable (refusal depends only on the chain); mix failed/ok instead.
- Concurrency cap: stub fetch that yields (setTimeout 2ms) while counting in-flight; max must equal 8.
- Break-check driver: python script taking (file, old, new) edit lists, running vitest, restoring bytes in `finally`.
