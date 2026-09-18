---
name: operator-switch-branching
description: How flows branch on an operator switch (NEO-287 PAUSED_PLATFORMS) — `-e` flag → one evalScript util → `when: { true: "${output.X}" }` pairs, verified on Maestro 2.8.0; plus the two structural facts a paused SportLots imposes on every drill (empty Manufacturers column, BSC-only Base reads as unmapped)
metadata:
  type: reference
---

# Branching a flow on an operator switch (verified on the pinned CLI 2.8.0, 2026-09-17)

**Never branch on the visible notice** (`when: visible:` polls the optional-lookup
timeout on every run the notice is absent — R10). Branch on a script flag:

* Runner scripts pass `-e "PAUSED_PLATFORMS=${PAUSED_PLATFORMS:-}"` ALWAYS (empty
  when unset). `flows/util/util-paused-platforms.yaml` is one `evalScript` that sets
  `output.SL_PAUSED` (boolean) with a `typeof` guard.
* `output` is ONE HashMap per run (`GraalJsEngine.outputBinding`), shared with every
  `runFlow` child both ways — a util can set a flag the caller reads.
* `when: { true: "<s>" }` is false iff the interpolated string is blank, `"false"`,
  `"undefined"` or `"null"` (`Orchestra.evaluateCondition`, decompiled). An UNSET
  `-e`/`env:` variable interpolates to `undefined` (no ReferenceError), so
  `"${SOME_ENV}"` is a free "was this passed" test; `"${!output.X}"` is the
  negation. Probed all four shapes (set / empty / unset / `env:` passthrough scoped
  to one `runFlow` call) — all behave as above.
* Shape: `runFlow util` once, then a `when: true: "${!output.X}"` block holding the
  live steps VERBATIM (indented) and a `when: true: "${output.X}"` block that ends in
  hard asserts (R2), so a runner whose flag disagrees with its deployment fails by
  name. Helper that does the indent+wrap: scratch `branch.py` (six-space indent).

# What a paused SportLots does to the set builder (drills must know)

0. **Below the root the pause is INDISTINGUISHABLE from a BSC-only tree.** A side
   is "paused" only where it is served AND its ids are complete; the root Sports
   sync never asks SportLots, so the sport row is written with no SportLots id and
   every lower level skips SportLots for want of ids. The paused sentence appears
   ONLY in the root Sports notice (plus the Profile card and the Set Builder
   strip). Years: `SportLots skipped: no SportLots ids on this path.`;
   Manufacturers: silently empty (`No manufacturers available. Sync from
   marketplaces to populate.`, no notice); base picker SL pane: `SportLots
   returned no base set for <set>`; checklist: the plain solo line. Paused
   branches below the root assert THAT, never the paused sentence (PR #265 push 3
   red).
1. **The Manufacturers column is EMPTY on a fresh deployment.** Manufacturer rows
   come from SportLots' brand list only (`PLATFORM_LEVEL_SUPPORT` in
   `convex/platformLevels.ts`); BSC sets are filed under existing manufacturer rows
   by name prefix (`syncSetsAcrossManufacturers`, which keys on ALL rows under the
   year, ids or not). Settle the cold-column way (wait out `Syncing Manufacturer
   Options`, then gate on the idle text OR the row). The seed adds `Topps` with the
   column's `+ Custom` form (`Add custom Manufacturers` → `Enter custom value...` →
   Enter → `Create manufacturer`); cold drills add theirs the same way (sole writer
   of the path). Centring `+ Custom` runs the page to MAXIMUM scroll, leaving the
   new row at y≈23 and the column HEADER above the top edge — a `below: text:
   "Manufacturers"` selector cannot resolve without its anchor, so scroll UP
   (centred) to the row after a create; the no-create row sits at y≈514 and wants
   DOWN. Centring swipes ONLY in the command's direction and acceptance is
   direction-aware (decompiled `Orchestra.scrollUntilVisible` /
   `UiElement.isElementNearScreenCenter`: UP accepts centre < ~437, DOWN accepts
   centre > ~187), so the direction must match where the target is.
2. **A BSC-only Base still reads as UNMAPPED** (`baseHasMapping` counts the
   SportLots slot only): the picker auto-opens on EVERY visit and after a BSC-only
   confirm the mapping block renders neither "Re-map Base" nor "Map Base Set".
   Read-only drills leave it Cancel → "Base mapping cancelled" → Close → "Map Base
   Set" (no write); only the seed confirms BSC-only. Do not anchor on "Re-map Base"
   under the pause.
3. The checklist fetch takes the NEO-255 solo path (`Kept all N cards from BSC`,
   no Match Cards dialog). With a wizard the sentence persists in the wizard notice;
   with no wizard the immediate commit replaces it with `Saved N cards` — assert
   the negative (`Match Cards.*` absent) and let the strict `Saved N` gate be the
   positive pair. With ONE marketplace the insert-level sync fills the column
   directly — there is no `Reconcile Inserts` dialog at all.
4. Under the pause after the run's reset NO worker has a connected SportLots row
   (the seed skips the site before any write), so the disabled "Test paused" /
   "Sign-in paused" labels are unreachable in CI; assert the card heading
   `SportLots is on pause` and the shared body prefix
   `Sign-ins to SportLots are benched for now.*` instead. maestro-web exposes no
   focus attribute, so "focus parked on the heading" is not E2E-assertable.
5. A column's `SyncDoneNotice` renders BELOW its fixed-height list and above the
   idle buttons, ~40px under the fold when a row is centred: SCROLL to it, never
   bare-assert it, and re-centre the row (UP) before tapping it.
