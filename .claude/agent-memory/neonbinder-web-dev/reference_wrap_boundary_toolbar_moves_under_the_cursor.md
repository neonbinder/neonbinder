---
name: reference-wrap-boundary-toolbar-moves-under-the-cursor
description: An admin filter toolbar whose children are content-sized reflows when a live query resolves, moving the trailing button ~650px mid-tap — fix the width in product code; scrollUntilVisible + centerElement cannot help
metadata:
  type: reference
---

The admin master-detail screens share one filter toolbar shape:
`flex flex-wrap items-end gap-3` holding a `w-64` filter Input, a **bare
`<div>`** wrapping a `w-full` `<select>` of sports, an auto-width counter `<p>`,
and the `Add …` button. At the CI E2E viewport (1024x629) that row sits right at
its wrap boundary, and two of its children size themselves from data:

- the select's width is its longest `<option>`, and `sportList` is a live global
  query — another session minting or deleting a sport changes it;
- the counter is empty until the counts resolve, then jumps to ~200px.

When either lands, the row flips from wrapped to inline and the trailing button
moves right and up by roughly a row's worth — after the driver resolved its
coordinates and before the tap lands.

**The flow cannot fix this.** `scrollUntilVisible` + `centerElement` re-reads the
element's bounds, but a re-read cannot out-run a layout change that has not
happened yet; a hardened flow failed again with byte-identical bounds. Treat a
tap-miss whose reported coordinates differ from the element's later bounds as a
product layout defect, per [[e2e-never-target-a-dom-id]]-style reasoning: fix it
where the width comes from.

**The fix** is two class changes per screen — a fixed width on the select's
wrapper (`w-44`) and a `min-w-[13rem]` floor on the counter — so the row's width
no longer depends on the data. Live sites as of 2026-09:
`components/admin/LeagueManagement.tsx` and `components/admin/PlayerManagement.tsx`
(both carry an in-file note). `FranchiseManagement.tsx` and `TeamManagement.tsx`
open with the same `flex flex-wrap items-end gap-3` row — check them before
adding another per-flow workaround.

Related: [[e2e-viewport-is-the-ux-constraint]].
