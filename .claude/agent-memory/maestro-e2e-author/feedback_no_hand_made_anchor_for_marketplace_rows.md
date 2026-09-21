---
name: no-hand-made-anchor-for-marketplace-rows
description: Owner rejection (NEO-293, 2026-09-21) — never nest, attach or otherwise anchor marketplace-synced rows under a hand-made row to make a fixture reachable; the harness's limits (no drag, prefix-only suggestion) never dictate the data shape; and a chip/tag rendering is not proof — prove a marketplace answered with a real fetch and its per-slot card count
metadata:
  type: feedback
---

Rule: a fixture that needs marketplace-synced rows in a particular shape gets a
REAL set whose marketplace lists already have that shape (a new sole-writer
set, owner-approved), never a hand-made row inserted to make the harness's
path work. Concretely: do not create a "+ Custom" parent so that Group
Parallels will auto-suggest BSC-synced children under it. And when the
requirement is "the marketplace still answers for this row", assert the
answer — Fetch from Marketplaces, cards saved, the chip's detach-confirm
per-slot count > 0 — not the rendering of the tag that should make it answer.

**Why:** Jason, 2026-09-21, rejecting the first NEO-293 flow: "a custom set is
by definition not connected to BSC ... it shouldn't carry any BSC data on the
new custom parallel." Nesting BSC rows under a hand-made parent is the
marketplace-data-on-custom-rows shape the fixture policy forbids, even though
the child rows themselves were real; and asserting the chip was "a rendering
of the tag write, not proof the marketplace answers the query". Every PR
ships straight to prod, so the flow must prove the requirement END TO END on
live marketplace data.

**How to apply:**
- Before choosing a fixture, ask: does any real set already have this shape?
  If the answer needs a marketplace list you cannot read from a workstation
  (BSC's API needs a bearer token; production reads are permission-gated),
  say so and use the owner's observed evidence — do not guess a list.
- A hand-made row is allowed only where the product has no other source for
  it (the Manufacturer row under the SportLots pause) and only by the path's
  sole writer, as `util-drill-to-2024-topps-chrome`'s `CREATE_MANUFACTURER`
  does.
- "Proof" for a sync/fetch feature is the fetch's own result on screen
  (`Kept all N cards from BSC`, `Match Cards`, `Saved N cards`) plus the
  per-source count on the chip (`N cards were fetched from it; their BSC link
  will be dropped`, then Cancel) — the NEO-219 pattern in
  `inserts-1996-score-…` STEP 9.
