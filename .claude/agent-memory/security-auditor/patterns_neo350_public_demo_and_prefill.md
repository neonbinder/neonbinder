---
name: patterns-neo350-public-demo-and-prefill
description: Auditing a client-only demo on a public route (import-graph check for convex/clerk) and a URL-param prefill into the print sheet (allowlist at parse AND at interpolation); branch-commit author email as a public-repo hygiene check
metadata:
  type: project
---

NEO-350 put a hard-coded collection demo on the public `/binder-tracking` page
(`?demo=on`) and let `/print/spine-label` prefill from `?name=&bg=&fg=&font=`.

**Public client-only demo: what to check**
- Import graph, not comments: grep every `from "..."` under the demo tree and
  the shared components it pulls in for `convex`, `@/convex`, `clerk`. A single
  `useQuery` anywhere in the lazy chunk would hit Convex unauthenticated.
- URL params must be lookup keys only (binder id, set id, tab) and every
  `navigate()` must be search-only (`{ search }`), so no param can steer an
  absolute URL (open redirect / `javascript:`).
- Every link to a signed-in tool must be remapped in public mode (the demo's
  `PUBLIC_DESTINATIONS`); check the remap targets are real public routes.

**URL prefill into an HTML/CSS sink (spine sheet)**
- Name: text context, `escapeHtml` is enough; it never reaches Convex.
- Colours: `normalizeHexColor` at parse AND `cssColor` hex allowlist at the
  interpolation point (see [[patterns-neo147-outbound-scrape]] for why escaping
  is not enough inside `style=`). Both layers must stay.
- Font: id checked against `SPINE_FONTS`; the family string comes from the table,
  single-quoted by `spineFontFamilyCss`.
- The target route is behind ProtectedLayout, so a crafted link only seeds a
  signed-in user's own form; nothing is queued or saved.

**Public-repo hygiene on a branch:** `git log --format=%ae origin/main..HEAD`.
Branch commits authored with a machine-local email expose the host name in the
public PR's commit list even though the squash commit on main is clean.
