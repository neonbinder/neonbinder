---
name: feedback-no-secrets-via-env
description: Never pass BSC/SportLots credentials through a spec's own env, args or artifacts; they leak into public CI output
metadata:
  type: feedback
---

Hard rule (from NEO-29, carried over): marketplace usernames and passwords must
NEVER appear in a spec file, a test argument, a logged value or a run
artifact, and never be typed from a variable a CI step exports for the spec.

**Why:** the previous harness serialised its entire env map into debug output
that was uploaded as a PUBLIC CI artifact, and real marketplace passwords
leaked that way. The same applies to Playwright traces (they record Clerk
testing tokens and request bodies): never upload or commit traces, videos or
HTML reports with data in them.

**How to apply:**
- Credential FORM specs (save, setup, clear-then-setup): type fake literals
  and assert the "saved but authentication failed" state.
- Real-auth coverage: route sign-in through `/testing/seed-credentials`
  (GUIDE "Worker-state seeding"), which seeds server-side from the deployment's
  env; or use `support/credentials.ts`.
- Never add a `wip` tag to work around this; fix the underlying security issue.

See [[patterns-credential-seeding]] for the implementation patterns.
