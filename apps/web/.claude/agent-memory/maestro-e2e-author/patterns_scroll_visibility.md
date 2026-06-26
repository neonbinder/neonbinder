---
name: patterns-scroll-visibility
description: When scrollUntilVisible with centerElement reports visibilityPercentageNormalized=0.0 and loops, and the two-step write pattern for avoiding no-op idempotency on metadata/feature edits.
metadata:
  type: feedback
---

## centerElement + visibilityPercentageNormalized=0.0 infinite loop

**Rule:** When `scrollUntilVisible` with `centerElement: true` reports `visibilityPercentageNormalized: 0.0` throughout all scroll tries, the centering loop runs until timeout. The element IS found (bounds non-zero, `Visibility Percent: 1.0`) but CDP's `elementFromPoint` hit-test returns 0% normalized visibility — typically because the element is inside a clipped/stacking-context area, or the browser's DevTools panel reduces the usable viewport height below the element's y-position.

**Symptoms in log:**
```
Element bounds: Bounds(x=41, y=652, width=376, height=26)
Visibility Percent: 1.0
visibilityPercentageNormalized: 0.0
```
Repeats every ~1.5s until timeout.

**Fix:** Omit `centerElement` for elements that exhibit this pattern. The scroll still scrolls the page and `Visibility Percent: 1.0` satisfies `visibilityPercentage: 10` without requiring the CDP normalized check.

```yaml
# BROKEN — centerElement loops on 0.0 normalized
- scrollUntilVisible:
    element:
      id: "Value for Release Date"
    centerElement: true
    visibilityPercentage: 10
    timeout: 10000

# FIXED — omit centerElement, keep visibilityPercentage + waitToSettle
- scrollUntilVisible:
    element:
      id: "Value for Release Date"
    visibilityPercentage: 10
    waitToSettleTimeoutMs: 1000
    timeout: 15000
```

**Why it works for other elements (e.g. "Edit attributes" button):**
The "Edit attributes" button at x=740 on a 1200px-wide local browser completes after ~8s despite the same 0.0 normalized pattern. The centering attempts throw CDP JS errors (connection reset), and after enough retry cycles the scroll "gives up" and completes. For elements deeper in the page (more scrolling required), the 10-15s timeout runs out before those error-retry cycles accumulate.

**Affected elements:** SetAttributesPanel metadata fields (Release Date, Total Cards, Block) — they render AFTER all 10 feature rows in the 2-column grid, so they're ~500px below the panel top and frequently below the fold.

---

## Two-step write to avoid no-op idempotency

**Rule:** When testing that a save action produces a toast (e.g. "Saved Release Date"), the component's `commit()` checks `if (trimmed === currentValue) return` before calling the mutation. If the DB already has the sentinel value from a prior test run, the write is silently skipped and no toast fires — causing `extendedWaitUntil: visible: ".*Saved Release Date.*"` to time out.

**Fix:** Use the same two-step pattern as features-propagation.yaml:
1. Write a "clearing" sentinel (a value that is definitively NOT the intended final value)
2. Wait for the toast
3. Write the intended sentinel value
4. Wait for the toast again

The second write is always genuine because step 1 just changed the DB to a different value.

```yaml
# FRAGILE — no-op if DB already has "2024-08-01"
- tapOn:
    id: "Value for Release Date"
- eraseText: 30
- inputText: "2024-08-01"
- pressKey: Enter
- extendedWaitUntil:
    visible:
      text: ".*Saved Release Date.*"
    timeout: 15000

# ROBUST — always genuine write on step 2
- tapOn:
    id: "Value for Release Date"
- eraseText: 30
- inputText: "1900-01-01"
- pressKey: Enter
- extendedWaitUntil:
    visible:
      text: ".*Saved Release Date.*"
    timeout: 15000

- tapOn:
    id: "Value for Release Date"
- eraseText: 30
- inputText: "2024-08-01"
- pressKey: Enter
- extendedWaitUntil:
    visible:
      text: ".*Saved Release Date.*"
    timeout: 15000
```

**Clearing sentinel rules:**
- For Release Date: use "1900-01-01" (not a real test value)
- For League (feature): use "AttrEdit-CLEAR" (not a real feature value)
- For features-propagation.yaml: uses "PropTest-X" → "PropTest-MLB" pattern

**Same rule applies to feature fields:** `SetFeatureRow.commit()` has the identical `if (trimmed === currentValue) return` guard.
