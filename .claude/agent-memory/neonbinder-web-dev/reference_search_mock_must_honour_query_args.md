---
name: search-mock-must-honour-query-args
description: A component test whose useQuery mock returns the whole pool for every query arg silently relies on a client re-filter — remove that filter and a dozen "No matches"/match tests go red
metadata:
  type: reference
---

TeamPicker.test.tsx's `teams.pickerCandidates` mock used to hand back every
`currentCandidates` row whatever `args.query` said. That only worked because
the picker re-filtered server rows by name client-side. When NEO-331 stopped
re-filtering the CURRENT answer (alias hits like "Aardvarks" → "Zzz Club"
were being dropped), the mock had to emulate the server: name-match on
`args.query` with the same `nameMatchesQuery(teamFullName(...))`, plus a
`currentAliasHits[query]` table for the exact-alias leg.

**How to apply:** before deleting a client-side filter over a server search
result, check whether the test's useQuery mock reads its args. If it does
not, make the mock answer like the server first, then delete the filter.
Held/stale rows (an earlier query's answer kept while the next loads) still
need the client filter — "fewer rows, never wrong ones". Related:
[[component-tests-hand-build-the-api-mock]].
