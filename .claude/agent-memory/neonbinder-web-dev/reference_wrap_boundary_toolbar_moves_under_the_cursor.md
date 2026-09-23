---
name: reference-wrap-boundary-toolbar-moves-under-the-cursor
description: An admin filter toolbar whose children are content-sized reflows when a live query resolves, moving the trailing button ~650px mid-tap — fix the width in product code (all four admin screens now carry it); the fixed width follows the longest realistic option, not a constant
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
wrapper and a `min-w-[13rem]` floor on the counter — so the row's width no
longer depends on the data. All four admin master-detail screens carry it as of
2026-09-22, each with an in-file note: `LeagueManagement.tsx` (the long note the
other three point at), `PlayerManagement.tsx`, `FranchiseManagement.tsx` and
`TeamManagement.tsx`. Before adding another per-flow workaround, check whether a
new screen opened with this row shape.

**The fixed width is not always `w-44`.** It has to hold the longest realistic
option, and that depends on what the select lists:

- a *sport* select (`sportList`) tops out near "Basketball", so `w-44` (176px)
  is comfortable;
- a *league* select renders `abbreviation ?? name`, and `findOrCreateLeague`
  writes rows mid-import with no abbreviation — so it must hold a full name like
  "Major League Baseball", "International League" or an FBS conference. That
  needs `w-72` (288px): 288 − 24 (`px-3`) − ~20 (Chrome's dropdown indicator)
  ≈ 244px of text, ~28 characters at 16px Lexend.

Check the row still fits the 1024px CI viewport at the new width. The admin
content box is `max-w-6xl mx-auto p-6`, i.e. 1024 − 48 ≈ 976px (~961 with a
classic scrollbar). A row of `w-64` Input + `w-72` select + `min-w-[13rem]`
counter + two `gap-3` is 776px, and stays inline even when the counter grows
past its floor.

**`min-w` is a floor, not a cap.** A counter whose text can outgrow ~13rem (Team
Management's reaches ~57 characters at the 2000-row cap) still changes width
with the data. That is only safe because it is the *last* in-flow child there —
nothing sits to its right to be moved. A screen that puts a button after the
counter needs the counter bounded, not just floored.

Two things to check on a screen you are closing out, beyond the two classes:

- a counter with a bare `pb-2` and no height class is the pre-fix pattern. The
  treatment is `flex items-center` + the shared `FIELD_BOX_HEIGHT`
  (`min-h-[2.625rem]`, exported from `components/admin/AddLeagueForm.tsx`), so
  it centres against the field boxes and stays put when the row wraps.
- the select's own query matters as much as the counter's. Team Management's
  `leagues` is a *separate* `useQuery` from the `management` query the screen
  early-returns on, so the row renders with the select at "All leagues" width
  and then jumps when `leagues` lands — a hazard the counter's early return
  hides.

Related: [[e2e-viewport-is-the-ux-constraint]].
