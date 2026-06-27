---
name: Canonical pre-synced setup data (set-selector)
description: Exactly what the global setup.yaml flow pre-syncs into the shared Convex deployment — the data every other flow may fast-drill to and read WITHOUT syncing
type: project
---

# Canonical Pre-Synced Setup Data

The global setup **track** runs ONCE, as worker 0, before every other flow. It is
**ONE flow** (NEO-62 Lever 1 — collapsed from 3 flows):

1. `.maestro/flows/setup.yaml` — global "Reset Set Builder Data" wipe, seed
   teams, warm worker 0, drill Baseball→2024→Topps→Topps Chrome, sync Variant
   Types, fetch + save **Base** cards. After the Base fetch, re-drill via
   `util-drill-to-2024-topps-chrome` (fast, no syncs — all data already in
   Convex) → tap "Insert" → ReconciliationModal → save matched variants +
   fetch **Future Stars** cards. Re-drill again via the same util → tap
   "Parallel" → ReconciliationModal → save matched variants + fetch **Gold
   Wave Refractors** cards.

**Why re-drill instead of in-place switch (NEO-62 discovery):** after the Base
card fetch, the CardChecklist fills the HORIZONTAL viewport (the rightmost column
in the SetSelector's overflow-x-auto layout). The Variant Types column with
"Insert" is horizontally off-screen to the LEFT. Maestro's `scrollUntilVisible`
only scrolls vertically — it cannot reach a horizontally-clipped element. The
`util-drill-to-2024-topps-chrome` util does `openLink /set-selector` (resets
page state) then fast-drills to Topps Chrome, leaving "Variant Types" visible
with "Base" centered. "Insert" and "Parallel" are immediately below "Base" in
the column and reachable with standard `scrollUntilVisible direction:DOWN`.
One browser context = one sign-in, two extra drills (each ~16s), no re-login.

Every OTHER (feature) flow is independent: it signs in, **fast-drills** to this
data, and reads it — no syncs, no dep-graph tags, no global reset.

## What setup.yaml guarantees is present after it runs

| Layer | Pre-synced value(s) | How a flow reads it |
|---|---|---|
| Sport | **Baseball** | fast-drill, tap "Baseball" |
| Year | **2024** | search "2024", tap index 1 |
| Manufacturer | **Topps** | search "Topps", tap index 1 |
| Set | **Topps Chrome** | search "Topps Chrome", tap index 1 |
| Variant Types | **Base, Insert, Parallel** | already listed (no Sync needed) |
| Base cards | Base checklist fetched + saved | tap "Base" → checklist has `#NNN` rows |
| Insert variants | all matched Insert variants **saved** | tap "Insert" → Inserts column populated |
| Insert cards | **"Future Stars"** checklist fetched (~20 cards) | search "Future Stars" (index 1) → checklist populated |
| Parallel variants | all matched Parallel variants **saved** | tap "Parallel" → Parallels column populated |
| Parallel cards | **"Gold Wave Refractors"** checklist fetched (~300 cards) | search "Gold Wave Refractors" (index 1) → checklist populated |
| Teams | **New York Yankees, New York Mets** seeded | TeamPicker typeahead match |

Canonical insert = `Future Stars` (**exactly 20 cards**). Canonical parallel =
`Gold Wave Refractors` (**exactly 300 cards**). A card checklist is IMMUTABLE once
produced — these counts do not change. Assert them STRICTLY (`Saved 20 cards` /
`Saved 300 cards`). If a count assertion fails, it is a real fetch/save
regression — fix the bug, do NOT loosen the assertion. (There is no "marketplace
drift": the only time a produced checklist changes is a rare post-launch
correction, which is not something flows plan around.)

## NOT pre-synced (sync it yourself, and accept the cost)

- Any other **year / manufacturer / set** — e.g. Topps Update, Topps Pro Debut,
  Topps Wonderland. Flows that used those (old parallel-grouping / variant-metadata
  tests) must either move to Topps Chrome, or sync their own set (slow), or the
  setup inventory must be extended (update setup.yaml AND this file together).
- Any other **sport** (only Baseball is synced).
- Any non-Topps-Chrome **variant rows** beyond the matched sets saved above.
- Custom subtrees (Football → 2026 → … playground) — those flows still build
  their own custom entries via the custom-drill utils.

## Rules this enables

- **No flow should call the global "Reset Set Builder Data" button** except
  setup.yaml. A flow that resets mid-suite wipes this data for everyone.
- **No `requires:` / `provides:` cascade tags.** The dep graph is gone; setup
  builds the data, all other flows are independent and read it.
- **Default ~7s waits.** Because data is warm, every UI interaction in a feature
  flow should respond in <7s. The long (240s / 90s) waits belong ONLY to
  setup.yaml (the warm track) — never copy them into a feature flow.
- Per-worker credential warming is the runner's job (loops `worker-bootstrap.yaml`
  per worker via MAESTRO_PARALLELISM), not setup.yaml's. setup only warms worker 0.
  Note: the CI seed job runs with MAESTRO_SKIP_BOOTSTRAP=1 (NEO-62 Lever 2) —
  setup.yaml is fully self-sufficient via its sign-in→reset→seed-credentials URL chain.

## Keep in sync

The inventory header inside `.maestro/flows/setup.yaml` and this file are the two
sources of truth. Change one → change the other.
