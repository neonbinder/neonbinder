---
name: patterns_util_drill_to_custom
description: util-drill-to-custom.yaml — general parameterized EntitySelector drill; per-level algorithm; search-vs-custom decision; return contract
metadata:
  type: project
---

`set-selector/util-drill-to-custom.yaml` is the general-purpose drill util. It replaces per-depth purpose-built drills for any caller needing Baseball/2024/Topps/customSet/Insert/Base or similar paths.

## Inputs (all optional via env)
SPORT, YEAR, MANUFACTURER, SET_NAME, VARIANT_TYPE, VARIANT — identical names to util-drill-to-custom-set for easy migration.

## Per-level algorithm (idempotent, real-or-custom uniform)
1. Wait for column header (confirms render).
2. Check for search input (real-synced large list) OR Add-custom button (custom/short list).
3. If target visible: tap it directly via `below: id:"Search <col>"` relationship (never `index:`).
4. If not visible and search input exists: type value in search; if not found in results → clear → Add-custom → re-search → tap.
5. If not visible and no search input: scrollUntilVisible Add-custom (centerElement:true) → tap → inputText → Enter → wait notVisible modal → tap value.
6. Wait for next column header before proceeding.

## NEO-219: every add-custom step is `inputText` → Enter → **Enter**
The custom form raises a `Create {noun} '{v}' under {A} › {B}?` confirm with
Create already focused, so the second Enter presses it. All 9 add sites in this
util carry it. See [[neo219-confirm-surfaces]].

## Key gotchas embedded in the util
- **Sports column**: real-synced always has search input after Baseball idle-signal; custom sports are added via search→not-found→Add-custom branch (search input remains present because real sports are alongside).
- **Variant Types column (Level 5)**: do NOT scroll — CDP throws MismatchedInputException during page re-render after fresh Set creation. Use non-scrolling `extendedWaitUntil id:"Add custom Variant Types"` instead. (History: centerElement → CDP crash; visibilityPercentage:100 → same crash.)
- **Sets column (Level 4)**: `centerElement:true` on Add-custom required (keeps the target fully in view); UP-scroll trick after centerElement to rescue Search-sets from under the nav header. **FIX 2026-07-12 (neo-71-74):** that UP-scroll rescue must run BEFORE the `when: visible: ".*Search sets.*"` guard, not inside it (it was inside → chicken-and-egg: if the centerElement-to-"+Custom" scroll already pushed "Search sets" under the sticky nav (y<66), the guard reads false, the search branch + its own rescue never run, and the fragile short-list FALLBACK direct-scrolls a target inside the Sets `overflow-y-auto` container → tap lands at y<0 → CDP "Failed to execute JS" / `null cannot be cast to non-null type kotlin.Int`). Hoisted it out as an `optional: true` `scrollUntilVisible text:"^Sets$" direction:UP centerElement` (no-op for short custom-sport lists). This was AGGRAVATED by the NEO-38 deepestSelectedId extension (collapsed SetAttributesPanel now renders below the column at sport/year/manufacturer levels → extra scroll height lets centerElement drag the column higher). Symptom flow: `set-attributes-edit` drilling custom set "attr-edit-0" under REAL Baseball/2024/Topps (long Sets list = search path).
- **Sets column below-fold fallback (FIX 2026-07-16, neo-71-74):** the short-list fallback's FIRST step was a non-optional `extendedWaitUntil visible SET_NAME` (a render-settle guard before the CDP swipe). The Sets column is `overflow-y-auto` (renders ALL custom sets, not virtualized). As the per-worker `E2E Test Sport N/2026/Topps` Sets list accumulates across flows (write-once selectorOptions; `/testing/reset` never wipes the catalog), a set whose basename sorts LATE alphabetically (e.g. `pp-0`/`tpc-0` after the many `c*-0` sets) lands BELOW the 629px fold while the list is still short enough that NO "Search sets" input renders (search box only appears past ~8 items). The non-optional wait then HARD-FAILS on that below-fold set before the following `scrollUntilVisible` can scroll to it (RCA: `player-picker-create-custom-card`, set `pp-0`). FIX: made that wait `optional: true` (+ timeout 5000, added `waitToSettleTimeoutMs:1000` to the scroll) → a below-fold set falls through to the scrollUntilVisible which DOES scroll the column to it; strict no-op for the common visible-near-top case; a genuinely missing set still fails loudly at the scroll. **Lesson for new custom-set flows: any late-sorting basename is now reliable, but keep basenames short & distinct.**
- **Search-input vs index**: ALWAYS use `below: id:"Search <col>"` to select a search result, never `index:` — (input, row) DOM order flips between cold sync and re-drill.
- **Double-tap prevention (Level 4)**: search-input branch emits `extendedWaitUntil visible: "Variant Types"` before returning; fallback is guarded `when: notVisible: "Variant Types"`.

## Return contract
- Deepest provided level is active; next column header is visible.
- If VARIANT provided: CardChecklist visible, "Open add card form" scrolled into viewport.
- If only SPORT+YEAR+MANUFACTURER+SET_NAME: Variant Types column visible, Add-custom-Variant-Types in viewport.
- If all 6 provided: CardChecklist at the VARIANT row, "Open add card form" visible.

## Limitation: no early-stop for missing vars
Maestro has no empty-variable check. If only SPORT is passed, the util drills to Level 2+ with defaults (YEAR=2024, etc.). Callers that need a shallower stop should pass all levels up to their intended depth.

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
