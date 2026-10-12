---
name: operator-switch-branching
description: How specs branch on an operator switch (NEO-287 PAUSED_PLATFORMS) via env.SL_PAUSED with both branches ending in hard asserts, plus the structural facts a paused SportLots imposes on every drill (empty Manufacturers column, BSC-only Base reads as unmapped)
metadata:
  type: reference
---

# Branching a spec on an operator switch

**The switch's state changes; never write that the suite "is" paused.** The
paused branches and everything below describe the paused mode only. Keep writing
both branches (GUIDE "Operator switches"). Check the run you are reading:
`gh run view <id> --log | grep -m1 "PAUSED_PLATFORMS: "` (empty = live). Reading a
live failure through the paused section below is a misread.

**Never branch on the visible notice**: the notice is absent on every live run,
so an optional-presence check just waits out its timeout (R10). Branch on the
flag: `env.SL_PAUSED` (from `support/env.ts`, unset reads as not paused). Shape:
`if (env.SL_PAUSED) { ...paused behaviour, hard asserts } else { ...live steps,
hard asserts }`. Both arms end in hard asserts (R2), so a runner whose flag
disagrees with its deployment fails by name.

# What a paused SportLots does to the set builder (only when the switch is ON)

0. **Below the root the pause is INDISTINGUISHABLE from a BSC-only tree.** A side
   is "paused" only where it is served AND its ids are complete; the root Sports
   sync never asks SportLots, so the sport row is written with no SportLots id and
   every lower level skips SportLots for want of ids. The paused sentence appears
   ONLY in the root Sports notice (plus the Profile card and the Set Builder
   strip). Years: `SportLots skipped: no SportLots ids on this path.`;
   Manufacturers: silently empty (`No manufacturers available. Sync from
   marketplaces to populate.`, no notice); base picker SL pane: `SportLots
   returned no base set for <set>`; checklist: the plain solo line. Paused branches
   below the root assert THAT, never the paused sentence.
1. **The Manufacturers column is EMPTY on a fresh deployment.** Manufacturer rows
   come from SportLots' brand list only (`PLATFORM_LEVEL_SUPPORT` in
   `convex/platformLevels.ts`); BSC sets are filed under existing manufacturer rows
   by name prefix (`syncSetsAcrossManufacturers`, which keys on ALL rows under the
   year, ids or not). Settle the cold column by waiting for the idle text OR the
   row (`.or()`), then add the manufacturer with the column's `+ Custom` form via
   the shared helper (`addCustomManufacturer`); the cold drill is the sole writer
   of its path.
2. **A BSC-only Base still reads as UNMAPPED** (`baseHasMapping` counts the
   SportLots slot only): the picker auto-opens on EVERY visit and after a BSC-only
   confirm the mapping block renders neither "Re-map Base" nor "Map Base Set".
   Read-only drills leave it Cancel, "Base mapping cancelled", Close, "Map Base
   Set" (no write); only the seed confirms BSC-only. Do not anchor on "Re-map Base"
   under the pause.
3. The checklist fetch takes the NEO-255 solo path (`Kept all N cards from BSC`,
   no Match Cards dialog). With a wizard the sentence persists in the wizard
   notice; with no wizard the immediate commit replaces it with `Saved N cards`:
   assert the negative (`Match Cards` absent) and let the strict `Saved N` assertion
   be the positive pair. With ONE marketplace the insert-level sync fills the
   column directly; there is no `Reconcile Inserts` dialog at all.
4. Under the pause after the run's reset NO worker has a connected SportLots row
   (the seed skips the site before any write), so the disabled "Test paused" /
   "Sign-in paused" labels are unreachable in CI; assert the card heading
   `SportLots is on pause` and the shared body prefix `Sign-ins to SportLots are
   benched for now` instead.
5. A column's `SyncDoneNotice` renders below its fixed-height list and above the
   idle buttons; scroll it into view (or assert `toBeInViewport`) rather than
   assuming it is on screen.
