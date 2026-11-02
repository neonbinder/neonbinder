---
name: reference-fixed-redirect-target-becomes-a-landing
description: When UI moves off a route an external redirect still targets (OAuth return), keep the route as a landing that Navigates (replace) with the payload in location.state; NavLink cannot light an alias
metadata:
  type: reference
---

Pattern used when eBay's setup moved from `/profile/ebay` into Profile → Credentials (NEO-415), while eBay's OAuth return pages (deployed separately) still forward to `/profile/ebay?code=&state=`.

- The old route renders a tiny eager landing: read the query, `<Navigate to="<new path>" replace state={{ ebayReturn }} />`. The secret rides in router location state, never a second URL; the panel spends it, then clears it with `navigate({ pathname, search, hash }, { replace: true, state: null })`.
- Remounting across a route change loses in-flight phase state (e.g. "Hooking up…"), so redirect FIRST and do the work on the destination; never spend on the landing and then navigate.
- Global observability scrubbers (code=/state= regex) still cover the landing URL in the first pageview and the forward's breadcrumb `from`.
- `NavLink` computes `aria-current` itself and cannot be told an alias is current: use `Link` + `matchPath({ path, end: false }, pathname)` over the section path and its aliases, and set `aria-current="page"` yourself.
- Tests: route both paths in the MemoryRouter (`/old` → landing, `/new` → panel + a `Where` probe recording `loc.state`), then sabotage the state reader once to prove the return tests go red.

Related: [[reference-router-navigation-is-a-transition]], [[reference-latest-entry-ref-is-stale-at-render-after-pop]].
