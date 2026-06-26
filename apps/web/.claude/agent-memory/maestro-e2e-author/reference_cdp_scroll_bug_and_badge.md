---
name: CDP scroll-bug flake class + Custom-badge assertion (NEO-46)
description: scrollUntilVisible throws a CDP error during mid-re-render (use non-scrolling waits for in-viewport elements); and how to assert the "Custom" badge correctly
type: reference
---

Two robustness findings from converting the custom-insert/parallel cluster.

## 1. scrollUntilVisible CDP scroll-bug on mid-re-render (a flake CLASS)
On Maestro web headless, `scrollUntilVisible` can throw
`MismatchedInputException: No content to map due to end-of-input` at
`maestro.drivers.CdpWebDriver.scroll` — it retries the whole timeout then fails
with `ElementNotFound`, EVEN WHEN the target element is rendered and in the
viewport. Root cause: the CDP scroll's `Runtime.evaluate` returns empty while
the page is still RE-RENDERING (e.g. right after a fresh custom set is
created + selected, or right after adding a list entry). It is INTERMITTENT:
the same step passes when the page is already settled (e.g. the entity
pre-existed, so no create/re-render happened).

This is the CI-representative failure: `setup.yaml` resets all data each run, so
CI always hits the FRESH-creation path where the re-render fires.

Fix pattern:
- If the target is reliably IN the viewport (a short column, an empty-state
  string, the "+ Custom" idle button of a 0-item column), do NOT scroll — use a
  non-scrolling `extendedWaitUntil: visible: {id/text}` (or `assertVisible`).
  This both signals "idle/ready" AND dodges the CDP scroll bug.
  - Done in `util-drill-to-custom-set.yaml` Variant Types idle wait: replaced
    `scrollUntilVisible id "Add custom Variant Types" visibilityPercentage:100`
    with `extendedWaitUntil visible id "Add custom Variant Types"`. Cut a 30s
    hang to 0.35s; benefits every custom-drill flow.
- Only `scrollUntilVisible` when the element is genuinely BELOW the fold (e.g.
  the CardChecklist / Metadata panel that renders under the columns) AND do it
  AFTER the triggering tap has settled (those scrolls work — page is stable).
- Symptom in maestro.log: repeated `CdpWebDriver.scroll ... MismatchedInputException`
  every ~2s for the full timeout. That's the scroll mechanic failing, not a
  real visibility problem — don't "fix" it by bumping the timeout.

## 2. Asserting the "Custom" badge on a custom entry
A custom entry row is `<button><div class="flex"><span>VALUE</span><span>Custom</span></div></button>`.
Maestro indexes the VALUE span and the badge span as SEPARATE elements, so a
combined regex like `".*VALUE.*Custom.*"` matches NOTHING (Chrome's a11y name is
"VALUE, Custom" but Maestro doesn't match on that). `text: "VALUE"` matches the
value span; bare `text: "Custom"` is ambiguous (also the column's "+ Custom"
button). Assert the badge pinned to its row:
```yaml
- assertVisible: ".*VALUE.*"            # entry appeared
- assertVisible:
    text: "Custom"
    rightOf:
      text: "VALUE"                      # the badge to the right of THIS value
```
Proven on cards-parallel-custom.yaml ("Prizm Gold").
