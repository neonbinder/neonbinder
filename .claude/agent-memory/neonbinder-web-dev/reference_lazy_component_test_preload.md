---
name: lazy-component-test-preload
description: A component test that renders a React.lazy() child and awaits it with findBy passes alone but times out (1s) under suite load; import the lazy module in beforeAll
metadata:
  type: reference
---

A `React.lazy(() => import(...))` child resolves only after Vite/vitest transforms
and evaluates its whole module graph. Cold, under a loaded machine (a parallel
`tsc`, the full components project), that outlasts Testing Library's default
1000 ms `findBy…` timeout, so the test fails intermittently with "Unable to find
role=…" while passing every time in isolation.

**Fix:** `beforeAll(async () => { await import("<same specifier the lazy() uses>"); })`.
The module is cached, `lazy()` still suspends a tick (so the Suspense path is
still exercised), and the `findBy` lands well inside its budget. Do not raise the
`findBy` timeout instead; it hides how slow the cold graph is.

**How to reproduce before trusting a green:** run the file set with two
`npx tsc -p . --noEmit &` in the background; the cold-import failure shows up
on the first or second run. Seen on NEO-350's `/binder-tracking` demo test.

Related: [[reference_playermanagement_deeplink_test_flakes_under_load]],
[[reference_component_test_at_a_real_cap_times_out]].
