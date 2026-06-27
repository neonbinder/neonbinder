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

## Key gotchas embedded in the util
- **Sports column**: real-synced always has search input after Baseball idle-signal; custom sports are added via search→not-found→Add-custom branch (search input remains present because real sports are alongside).
- **Variant Types column (Level 5)**: do NOT scroll — CDP throws MismatchedInputException during page re-render after fresh Set creation. Use non-scrolling `extendedWaitUntil id:"Add custom Variant Types"` instead. (History: centerElement → CDP crash; visibilityPercentage:100 → same crash.)
- **Sets column (Level 4)**: `centerElement:true` on Add-custom required (footer-steal at y≥489); UP-scroll trick after centerElement to rescue Search-sets from under the nav header.
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
