---
name: Cascade pattern (set-selector)
description: How the set-selector cascade flows are structured, what each provides/requires, and the fast-drill pattern used in cascade flows
type: project
---

# Set-Selector Cascade Pattern

## Directory
`.maestro/flows/set-selector/cascade/`

## Dep graph (3 levels)

```
Level 0 (1 flow):
  setup.yaml                         → provides: setup-done

Level 1 (5 flows, parallel, each requires: setup-done, provides: sets-loaded):
  sets-base.yaml                     → provides: sets-loaded
  sets-inserts.yaml                  → provides: sets-loaded
  sets-parallels.yaml                → provides: sets-loaded
  sets-move-parallels-of-inserts.yaml → provides: sets-loaded + parallels-of-inserts-moved
  sets-resync-already-loaded.yaml    → provides: sets-loaded

Level 2 (4 flows, parallel):
  cards-base.yaml                    → requires: sets-loaded, provides: cards-loaded
  cards-parallel.yaml                → requires: sets-loaded, provides: cards-loaded
  cards-insert.yaml                  → requires: sets-loaded, provides: cards-loaded
  cards-parallel-of-insert.yaml      → requires: parallels-of-inserts-moved, provides: cards-loaded
```

Note: `cards-parallel-of-insert` uses the finer `parallels-of-inserts-moved` state (not `sets-loaded`),
so it starts as soon as `sets-move-parallels-of-inserts` succeeds — not waiting for all 5 sets flows.

## Fast-drill pattern

cascade flows sign in fresh but do NOT run syncs. Instead:
- All 4 hierarchy levels (Baseball → 2024 → Topps → Topps Chrome) are already in DB from setup.yaml
- columns render with items immediately (no auto-sync fires on non-empty columns)
- Fast drill: wait for each item to appear, scroll, tap — no sync waits

Fast drill for Topps Chrome:
1. extendedWaitUntil: visible "Baseball" timeout: 30000 → tap
2. extendedWaitUntil: visible "Years" + "2024" timeout: 30000 → tap
3. extendedWaitUntil: visible "Manufacturers" + ".*Search manufacturers.*" → type "Topps" → tap index:1
4. extendedWaitUntil: visible "Sets" + ".*Search sets.*" → type "Topps Chrome" → tap index:1
5. extendedWaitUntil: visible "Variant Types" + target variant type → tap

## Isolated flows convention

Flows that do their own DB reset (via util-drill-to-2024-topps-chrome or util-drill-to-base-variant)
must be tagged `isolated:true` AND keep `serial-global` for back-compat. This means:
- All parallel-grouping-*.yaml flows
- All checklist-fetch-*.yaml flows
- checklist-renders-rich-fields.yaml
- checklist-keyboard-only-dialog.yaml
- checklist-fetch-with-known-entities.yaml (smoke, but isolated)
- variant-metadata-editor-insert.yaml
- insert-variant-flow.yaml

Flows that do NOT reset (set-selector-smoke, custom-entry-survives-resync) keep serial-global
without isolated:true — they don't conflict with cascade state.

## Deleted flows

- `base-set-picker.yaml` → replaced by `cascade/sets-base.yaml`
- `reconciliation-modal.yaml` → replaced by `cascade/sets-inserts.yaml` + `cascade/sets-parallels.yaml`

**Why:** cascade flows cover the same assertions (modal structure, cancel behavior) as part of
a broader dependency-aware pipeline. The standalone flows duplicated 4 minutes of setup each.
