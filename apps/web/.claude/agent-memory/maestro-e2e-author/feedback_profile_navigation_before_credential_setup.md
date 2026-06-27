---
name: Must navigate to /profile before calling setup-*-credentials.yaml via runFlow
description: runFlow does NOT change the browser URL; setup flows require the profile page to be loaded first
type: feedback
---

Before calling `setup-bsc-credentials.yaml` or `setup-sportlots-credentials.yaml` via `runFlow`,
the caller MUST explicitly navigate to `/profile` and wait for "Select Platform" to be visible.
`runFlow` does NOT re-navigate — it just inlines commands in the current browser context.

**Why:** Several set-selector flows (full-hierarchy-drill-down, card-checklist-sync,
add-custom-card-to-checklist, edit-and-delete-card, custom-entry-survives-resync) had this bug —
they called the setup sub-flows while the browser was still on /set-selector after the sign-in
redirect. The setup flows scroll for "Select Platform" and time out because the profile page
isn't loaded.

**How to apply:** Any flow whose `url:` header points to `/testing/sign-in?redirect=/set-selector`
(or any non-profile destination) that needs credentials must include this preamble before
the runFlow calls:

```yaml
- openLink: ${APP_URL || "https://localhost:3000"}/profile
- scrollUntilVisible:
    element:
      text: ".*Select Platform.*"
    timeout: 15000

- runFlow:
    file: ../profile/setup-bsc-credentials.yaml
    env:
      BSC_USERNAME: ${BSC_USERNAME}
      BSC_PASSWORD: ${BSC_PASSWORD}

- runFlow:
    file: ../profile/setup-sportlots-credentials.yaml
    env:
      SPORTLOTS_USERNAME: ${SPORTLOTS_USERNAME}
      SPORTLOTS_PASSWORD: ${SPORTLOTS_PASSWORD}

- openLink: ${APP_URL || "https://localhost:3000"}/set-selector
- extendedWaitUntil:
    visible: "Set Selector"
    timeout: 15000
```

Flows whose `url:` header already redirects to `/profile` (e.g., `set-selector-smoke.yaml`)
do NOT need the extra `openLink` before the setup sub-flows.
