---
name: aria-disabled-gate-stalls-shared-e2e-helpers
description: Playwright getByRole({ disabled: false }) treats aria-disabled as disabled, so a new aria-disabled hold on a shared button (Confirm card matches) stalls every spec whose helper waits for it
metadata:
  type: reference
---

Playwright's `getByRole(..., { disabled: false })` honours `aria-disabled="true"`, not only native `disabled`. The house pattern for a held primary button is `aria-disabled` (focusable, reason in `aria-describedby`), so adding a NEW hold condition to an existing button silently changes what `disabled: false` waits for.

Seen in NEO-339: holding "Confirm card matches" until every Match Cards conflict is answered (`openPairingConflicts`) means `playwright/support/wizard.ts` `fetchChecklistToWizard` (waits for `Confirm card matches`, `disabled: false`) and any spec doing the same will time out on a set with conflicts unless it answers them first.

**How to apply:** when you add a hold to a button, grep `playwright/support` and `playwright/tests` for its accessible name with `disabled: false` / `toBeEnabled`, and list every hit in the report as a spec the change breaks. Related: [[e2e-viewport-is-the-ux-constraint]], [[reference_new_string_locator_collision_sweep]].
