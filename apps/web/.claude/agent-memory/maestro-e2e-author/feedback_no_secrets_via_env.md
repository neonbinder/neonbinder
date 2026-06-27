---
name: feedback-no-secrets-via-env
description: Never pass BSC/SportLots credentials via Maestro -e env; they leak into public CI debug artifacts
metadata:
  type: feedback
---

Hard rule (from NEO-29): `${BSC_USERNAME}`, `${BSC_PASSWORD}`, `${SPORTLOTS_USERNAME}`, `${SPORTLOTS_PASSWORD}` must NEVER appear in any Maestro flow file — not in `inputText`, not in `runFlow env:` blocks.

**Why:** Maestro serializes the entire `-e` env map into its debug output, which is uploaded as a PUBLIC CI artifact. Real marketplace passwords leaked this way.

**How to apply:**
- Credential FORM flows (save-*, setup-*, clear-then-setup-*): use fake literals `"e2e-fake-user"` / `"e2e-fake-pass"` and assert the "saved but authentication failed" state.
- Real-auth coverage: route sign-in through `/testing/seed-credentials` which calls `seedMyTestCredentials` server-side from Convex env vars.
- Never add `wip` tag to work around this — fix the underlying security issue.

See [[patterns-credential-seeding]] for the implementation patterns.
