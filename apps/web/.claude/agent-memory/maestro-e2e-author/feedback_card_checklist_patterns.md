---
name: CardChecklist flow patterns
description: Scrolling to Refresh button past 335 rows, BaseMappingForm dual-path, fetch completion signals, and SL badge requirements
type: feedback
---

## Scrolling to "Refresh" button past 335+ card rows

The "Refresh" button renders OUTSIDE the white card div, BELOW all card rows,
in a `flex gap-2` container with "Add Card". With 335 rows (~17,500px scroll),
default speed (40) fails. Required params:

```yaml
- scrollUntilVisible:
    element:
      text: "Refresh"
    timeout: 120000
    visibilityPercentage: 1
    speed: 10
    waitToSettleTimeoutMs: 300
```

**Why:** High speed causes Maestro to overshoot, and the DOM detection window between
scroll events is too small. `speed: 10` is slow and precise enough to land on the button.

## Fetch completion signal after second fetch

After tapping "Refresh" at the BOTTOM of a 335-row list, the viewport stays at the bottom.
"Saved N cards" message is at the TOP of the Cards panel — `extendedWaitUntil: visible:` would
require scrolling back up. Better approach: wait for `notVisible: "Fetching..."` (the button
label changes from "Fetching..." back to "Refresh" when done — no scroll required):

```yaml
- tapOn: "Refresh"
- extendedWaitUntil:
    visible: "Fetching..."
    timeout: 10000
- extendedWaitUntil:
    notVisible: "Fetching..."
    timeout: 60000
- assertVisible: "Refresh"
```

## BaseMappingForm dual-path (CRITICAL — 2026-05-05)

When "Base" is tapped at Level 5, BaseMappingForm opens. Two paths:

**Path A (SL has options):** Picker stays visible. User must confirm. "Select Base Set" is visible.
**Path B (SL has no options / no SL session):** Picker auto-closes in <500ms. "Select Base Set" NEVER appears.
                                                  BSC fallback is written automatically.

Maestro's 500ms polling interval MISSES Path B. Guard with:

```yaml
- extendedWaitUntil:
    visible:
      text: ".*Select Base Set.*|.*Fetch from Marketplaces.*"
    timeout: 20000
- runFlow:
    when:
      visible: "Select Base Set"
    commands:
      - tapOn: "Confirm Base Set"
      - extendedWaitUntil:
          notVisible: "Select Base Set"
          timeout: 10000
```

**Why:** On fresh DB after reset, SL has no set-level mapping (ReconciliationModal writes it).
Without a set mapping, `fetchSportLotsChecklist` returns "No set identifier available for SportLots".
BaseMappingForm detects `slOptions.length === 0` and calls `setPickerOpen(false)` immediately.

## SL badge dual requirement (CANNOT test on fresh DB)

Two conditions BOTH required for "SL" badge to appear on cards:
1. Active SportLots session cookie (from `setup-sportlots-credentials.yaml`)
2. The set row (setName level) having `platformData.sportlots` written by ReconciliationModal

On a fresh DB after reset, condition 2 is absent — `fetchSportLotsChecklist` returns
"No set identifier available for SportLots", SL returns 0 cards, no "SL" badge appears.

Do NOT assert `assertVisible: "SL"` in flows that run after a DB reset without having first run
ReconciliationModal to write the set-level SL mapping.

## BSC "No BSC token" error at Sets/Variant Types levels

When BSC credentials are absent and a manufacturer is selected, the Sets column
auto-sync fires and shows "Syncing Sets" modal with "No BSC token available. Connect
your BSC account first." and a "Close" button. After dismissing:
- The Sets column shows "No sets available. Sync from marketplace to populate." (EMPTY STATE)
- The failed BSC sync ERASES previously cached Sets data from DB
- To continue drilling: use `+ Custom` at index 2 (with Years+Manufacturers selected and visible)
  - index 0 = Years column "+ Custom"
  - index 1 = Manufacturers column "+ Custom"
  - index 2 = Sets column "+ Custom"
- At Variant Types level: same pattern, "+ Custom" at index 3

Empty state text for matching in YAML: `".*No sets available.*"` (partial match required —
the full text is "No sets available. Sync from marketplace to populate.").

**BSC teardown contamination**: Tests that clear BSC credentials must restore them in teardown.
If BSC auto-auth fails during teardown (BSC login rejected), credentials ARE stored but the
BSC session/token is invalid. Subsequent tests using `setup-bsc-credentials.yaml` (idempotent)
will see "Clear Credentials" and SKIP re-auth — leaving the invalid token intact. This causes
`util-drill-to-2024-topps-chrome` to fail at the Sets level in subsequent test runs.

Fix: teardown should wait for "Clear Credentials" (storage confirmed) NOT "Credentials saved
successfully" (requires active BSC auth). This decouples teardown from BSC availability but
leaves the token potentially invalid for subsequent tests — acceptable locally, reliable on CI
(fresh deployments have no prior invalid token).

## Print-run numbers ("/<N>") are in PARALLEL sets, not Base

Numbered cards (e.g., `/99`, `/50`) are parallel variants. The 2024 Topps Chrome Base set
does NOT contain numbered cards. Do not use `".*/[0-9]+.*"` assertions on Base checklist flows.

## UnknownEntitiesDialog: re-run-safety depends on per-attempt entity names

`resetSetBuilderData` only deletes `selectorOptions` and `cardChecklist` rows.
Players and teams tables are NOT deleted. After the FIRST successful fetch run,
all entities exist → dialog never opens again for the SAME entity names.

**Re-run-safe pattern (confirmed 2026-06-19):** Use `${ATTEMPT_ID}` for ALL entity names
injected into a card-add form (player names, card name, card number when on a shared real set).
`ATTEMPT_ID` is unique per harness attempt, so players are always unknown on every run.
`checklist-fetch-unknown-entities-skip-some.yaml` was fixed with this pattern and now passes
two consecutive runs on the persistent dev Convex without a DB reset.

Flows still requiring an empty DB (use hardcoded or TEST_USERNAME-stable entity names):
- checklist-fetch-cancel-dialog.yaml
- checklist-fetch-unknown-entities-confirm.yaml
- checklist-keyboard-only-dialog.yaml

These tests are RELIABLE ON CI (fresh Convex preview per PR) but will fail locally after
the first run. Do NOT treat their local failure as a regression.

**Card number on shared real sets:** if a flow adds cards to the real "2024 Topps Chrome"
Base checklist (via `util-drill-to-base-variant.yaml`), the card number must also use
`${ATTEMPT_ID}` (e.g. `"9${ATTEMPT_ID}"`) — otherwise re-runs create a duplicate card
number that already exists in the DB, causing the form to reject or silently overwrite.
