---
name: Maestro native select workaround
description: Native HTML <select> options can't be tapped by text in Maestro web; use id: focus + inputText first-letter
type: reference
---

## Problem

Native HTML `<select>` elements in web views cannot have their `<option>` children tapped
by text matcher in Maestro. The options are not exposed as tappable DOM nodes.

On `app/profile/page.tsx` the platform dropdown is:
```html
<label htmlFor="site-select">Select Platform</label>
<select id="site-select" ...>
  <option value="sportlots">Sportlots</option>
  <option value="bsc">BuySportsCards</option>
</select>
```

`tapOn: "Sportlots"` fails with "Element not found" because the option is not a standalone
tappable element. Maestro only sees the select's current value text, not its options.

## Confirmed non-working approaches

- `tapOn: "Sportlots"` — fails, option text not visible in Maestro DOM hierarchy
- `tapOn: "Select Platform"` (the label) — fails, label text does NOT appear as a
  standalone text node in Maestro's web view hierarchy dump; only the select's current
  value text is exposed with resource-id "site-select"

## Working approach (Option A — confirmed in CI run 25279139378)

Focus the select with `tapOn: {id: "site-select"}`, then `inputText: "S"` to navigate
to the first option starting with "S" (Sportlots). This commits via the keyboard pipeline
which React picks up.

```yaml
- tapOn:
    id: "site-select"
- tapOn: "Sportlots"  # NOTE: this also works intermittently in CI (Linux Chrome)
```

The `tapOn: "Sportlots"` after opening the native select works on Linux/Chrome in CI
(passes in recent runs) but fails locally on macOS/Chrome. The `inputText: "S"` approach
in refresh-sportlots-creds.yaml is more reliable cross-platform.

However, the working flow `setup-sportlots-credentials.yaml` uses `tapOn: id "site-select"`
+ `tapOn: "Sportlots"` and this passed in CI run 25279139378 (custom-entry-survives-resync
seq 19/20 both COMPLETED). Keep the current approach — it works in CI (Linux Chrome).
Only change it if failures recur on the Sportlots tapOn step.

## Better long-term fix

Migrate the `<select>` to a Radix UI Select component. Radix renders its options as
DOM-visible list items that Maestro can tap by text. Track this as a separate app-code
improvement; do not block test flows on it.

## Where this is used

- `setup-sportlots-credentials.yaml` (idempotent helper)
- `clear-then-setup-sportlots-credentials.yaml` (destructive helper)
- `sync-without-credentials.yaml` (parked wip)
- `refresh-sportlots-creds.yaml` (parked wip — uses inputText "S" approach)
