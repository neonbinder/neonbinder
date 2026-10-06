---
name: patterns_util_drill_to_custom
description: util-drill-to-custom.yaml — general parameterized EntitySelector drill; one search path per level since NEO-224, the load-bearing Level 4 Variant Types guard, return contract
metadata:
  type: project
---

`set-selector/util-drill-to-custom.yaml` is the general-purpose drill util. It replaces per-depth purpose-built drills for any caller needing Baseball/2024/Topps/customSet/Insert/Base or similar paths.

## Inputs (all optional via env)
SPORT, YEAR, MANUFACTURER, SET_NAME, VARIANT_TYPE, VARIANT — identical names to util-drill-to-custom-set for easy migration.

## Per-level algorithm (NEO-224: ONE path)
Every open, unselected column renders its search box, so levels 1-3 are:
hard-wait the box (7000) → tap → type → if a row matches `below: id:"Search <col>"`
tap it, else "+ Custom" (centred) → type → Enter → `Create <noun>` button (only
if the confirm rendered) → wait the form out → tap the new row under the box.
The pre-NEO-224 "no search input" fallbacks (gated on the NEXT header being
absent) were removed — each cost a ~7s `notVisible` poll on every successful pick.
Never re-add a branch keyed on the box being absent.

Level 4 (Sets) creates first ("+ Custom" when `notVisible: SET_NAME`), then picks
through the box inside `when: notVisible: "Variant Types"`, with a hard
`scrollUntilVisible id:"Search sets" direction: UP centerElement` as precondition.
The VT guard is LOAD-BEARING, not dead: when SET_NAME exists but sits clipped in
a long real Sets list, the create submit selects the existing row
(`onSelectExisting`) and the cascade advances on its own — the pick must not
re-run. The old short-list fallback's VT guard was silently covering that
outcome; see [[dead-branch-guards-can-cover-a-second-outcome]].

## Key gotchas embedded in the util
- **Search-input vs index**: ALWAYS `below: id:"Search <col>"`, never `index:`.
- **Level 5 waits for the Sets collapsed card** (`Sets: <name> — change`, UP)
  before reading geometry: the Sets column collapses only when the Variant Types
  query lands, shifting every column right of it by 80px.
- **Add-custom form**: never a second blind Enter (NEO-272) — tap `Create <noun>`
  by name, conditionally (an already-existing value closes the form with no confirm).
- Remaining over-7000 waits in the util (header gates 30000/60000/20000, the
  10000 form-close/new-row waits, Variant Types 30000, `${VT}s` 15000) were not
  re-measured in NEO-224; any change there needs a measurement first.

## Return contract
- Deepest provided level is active; next column header is visible.
- If VARIANT provided: CardChecklist visible, "Open add card form" scrolled into viewport.
- If only SPORT+YEAR+MANUFACTURER+SET_NAME: Variant Types column visible, Add-custom-Variant-Types in viewport.
- If all 6 provided: CardChecklist at the VARIANT row, "Open add card form" visible.

## team-picker refactor (NEO-53)
Both inline ~110-line drills in team-picker.yaml were replaced with:
```yaml
- runFlow:
    file: util-drill-to-custom.yaml
    env:
      SPORT: "Baseball"
      YEAR: "2024"
      MANUFACTURER: "Topps"
      SET_NAME: "tp-${WORKER_INDEX || 0}"
      VARIANT_TYPE: "Insert"
      VARIANT: "Base"
```
team-picker shrank from 521 to 276 lines; the 9 sub-tests are byte-for-byte preserved.
