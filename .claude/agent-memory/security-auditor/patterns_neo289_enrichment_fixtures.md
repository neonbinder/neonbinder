---
name: neo289-enrichment-fixtures
description: NEO-289 recorded enrichment lookups — the two-env gate (opt-in flag AND TESTING_RESET_SECRET) is the house shape for "dev/preview only" behaviour; the recurring trap is arming an internal action with a SHELL env var on `npx convex run` (inert — the flag must be `convex env set` on the deployment)
metadata:
  type: project
---

Two durable rules from the NEO-289 audit (2026-09-20):

1. **"Test deployment only" behaviour gates on an opt-in flag AND
   `TESTING_RESET_SECRET`.** `adapters/enrichmentFixtures.ts:enrichmentFixturesEnabled`
   is the reference: the flag alone warns once and stays off, so a stray flag
   on prod is a log line. When reviewing a new dev/preview-only switch, check
   it reuses this pair rather than inventing a third "is this prod" signal.
   Also check that every reader of the gated data goes through the switch;
   here `getEnrichmentFixture`/`hasFixtureEntry` deliberately bypass it and
   are reachable only from an armed `internalAction`.

2. **An armed internal action reads `process.env` INSIDE the Convex runtime.**
   Prefixing `npx convex run` with `ALLOW_X=true` in a shell (a workflow step
   `env:` block, a runbook one-liner) does nothing; the flag must be
   `npx convex env set ALLOW_X true --deployment <slug>` and removed after.
   The NEO-289 e2e.yml coverage step and its runbook both made this mistake
   and the `continue-on-error` around the step hid it. When a workflow arms
   an internal action, grep for `convex env set <FLAG>` in the same step.

**Why:** a dead armed step passes green forever and its "operator signal"
never fires; a misread gate could equally let prod read test data.

**How to apply:** on any diff touching `convex/testing.ts`-style gates, armed
`*FromCli` actions, or a workflow step that runs `convex run` with an `env:`
block.
