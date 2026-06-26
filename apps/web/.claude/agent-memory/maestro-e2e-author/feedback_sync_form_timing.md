---
name: Sync form timing and auto-sync race condition
description: EntityColumn auto-fires sync when items are empty; "Sync X" button is never tappable on a fresh DB. Guard on data indicators, not button visibility.
type: feedback
---

## Auto-sync race condition (CRITICAL — added 2026-05-04)

`EntityColumn` has a `useEffect` that fires `setMode("sync")` immediately when the column
renders with an empty items list. This means after a DB reset, the "Sync X" button is NEVER
reliably tappable — auto-sync fires before a tap can land.

**Broken pattern (races with auto-sync):**
```yaml
- runFlow:
    when:
      visible: "Sync Years"   # ← auto-sync fires between check and tap → tap fails
    commands:
      - tapOn: "Sync Years"
```

**Correct pattern — guard on DATA, not on button:**
```yaml
- runFlow:
    when:
      notVisible: "2024"    # ← if data is absent, wait for auto-sync to populate it
    commands:
      - extendedWaitUntil:
          visible: "2024"
          timeout: 60000
```

For columns that have a search box (Manufacturers, Sets), the search input appearing is
the completion signal (search box only renders in mode=idle):
```yaml
- runFlow:
    when:
      notVisible: ".*Search manufacturers.*"
    commands:
      - extendedWaitUntil:
          visible: ".*Search manufacturers.*"
          timeout: 60000
```

For Variants column (Level 6 — non-Base variantType), guard on "Group Parallels" not being
visible (populated state shows "Group Parallels"). Auto-sync opens ReconciliationModal;
just wait for it:
```yaml
- runFlow:
    when:
      notVisible: "Group Parallels"
    commands:
      - extendedWaitUntil:
          visible: "Reconcile Variants"
          timeout: 90000
      - tapOn: "Cancel"
      - extendedWaitUntil:
          notVisible: "Reconcile Variants"
          timeout: 10000
```

## Data indicators by level

| Level | Column | "Data present" signal |
|---|---|---|
| 1 | Sports | `"Baseball"` visible |
| 2 | Years | `"2024"` visible |
| 3 | Manufacturers | `".*Search manufacturers.*"` visible (search box = mode=idle) |
| 4 | Sets | `".*Search sets.*"` visible (search box = mode=idle) |
| 5 | Variant Types | `"Base"` visible |
| 6 | Variants (non-Base) | `"Group Parallels"` visible |

## Legacy notes (still apply for Variant Types / intermediate states)

All set-selector sync forms auto-fire on mount. If data is already present or network is fast,
intermediate loading headings ("Syncing X") can disappear before Maestro evaluates an assertion.

**Exception — SetVariantForm (Sync Variant Types):** On RE-SYNC attempts (data already populated),
SetVariantForm returns `success: false` when no NEW options come back. `onDone()` is NOT called —
form stays open showing "Close" button. Use `when: notVisible: "Base"` guard so sync only runs
when the list is empty. After sync fires, wait for `notVisible: "Syncing Variant Types"`, then
dismiss any leftover "Close" button.

**Exception — VariantForm re-sync with partial data:** If only one platform returns data,
VariantForm stores directly and calls `onDone()` without opening ReconciliationModal. The
`when: notVisible: "Group Parallels"` guard handles this — if variants are already populated,
skip the modal step entirely.

**Why:** EntityColumn's useEffect fires synchronously on the first render with empty items.
By the time Maestro evaluates a `when: visible:` check, auto-sync may have already transitioned
mode to "sync" (hiding the button) or back to "idle" (with data populated). Guard on data
presence, not button presence.

**How to apply:** After any DB reset, treat ALL levels as auto-syncing. Never use
`when: visible: "Sync X"` as the entry condition for a sync block. Use the data-presence
patterns above.

Confirmed working in util-drill-to-2024-topps-chrome.yaml and util-drill-to-insert-variants.yaml
(smoke passing 2026-05-04).

## PR #25 — New auto-sync patterns for insert/parallel Variants column

After DB reset and selecting Insert or Parallel variantType, the Variants column renders
empty and auto-sync fires ReconciliationModal immediately. For flows that verify the
ReconciliationModal (insert-variant-flow.yaml, reconciliation-modal.yaml), the old pattern:

```yaml
- runFlow:
    when:
      visible: "No variants available. Sync from marketplaces to populate."
    commands:
      - tapOn: "Sync Variants"   # ← BROKEN: button is never in DOM, auto-sync took over
      - extendedWaitUntil: ...
```

Must become:
```yaml
- runFlow:
    when:
      visible: "No variants available. Sync from marketplaces to populate."
    commands:
      # No tap needed — auto-sync fires the modal automatically
      - extendedWaitUntil:
          visible: "Reconcile Variants"
          timeout: 90000
```

## PR #25 — Base as terminal variantType

When `variantType.value === "Base"`, the Variants column (Level 6) is SUPPRESSED.
BaseMappingForm auto-mounts and BaseSetPicker opens directly on the variantType row.
Do NOT write flows that expect "Variants" heading after tapping "Base".

Any flow that:
- Taps "Base" at Level 5 AND then waits for "Variants" → category-3, needs rewrite
- Uses `tapOn: index: 0` at Level 5 (alphabetically = "Base") → same issue

Safe variantType values for testing Variants column: "Insert", "Parallel".

## PR #25 — SL/BSC pills only on terminal items

SL and BSC text pills no longer appear on non-terminal levels:
- Sports, Years, Manufacturers, Sets, Variant Types → NO pills
- Terminal items (Base variantType rows, Variants entries, parallels) → pills appear

Any `assertVisible: "BSC"` or `assertVisible: "SL"` at the Sports level → replace
with `assertVisible: "Baseball"` as the data-presence proof.
