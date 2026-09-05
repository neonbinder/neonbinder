---
name: reference_ci_seed_resets_the_preview_under_your_local_run
description: A local Maestro run against a shared PR preview can be destroyed mid-flight by CI's own seed job running the global reset — the signature (columns emptying, "no <ancestor> ancestor" messages) is indistinguishable from a product bug, so check for a CI run before diagnosing one
metadata:
  type: reference
---

# CI's seed job will reset the preview out from under your local run

The PR preview Convex deployment is **shared with CI**, and `e2e.yml`'s `seed`
job opens with the global "Reset Set Builder Data". If a push happens while you
are running locally against `:3002`, that reset drains `selectorOptions` under
your live page.

## The signature — and why it reads as a product bug

Measured 2026-09-04 (NEO-239, `<preview-slug>`). The drill worked normally,
then mid-flow the page showed:

```
Years          "No years available. Sync from marketplaces to populate."
Sets           "No sets available…"  +  "Cannot sync sets — no year ancestor."
Variant Types  "Couldn't sync options — please try again."
Manufacturers  (still fully populated)
```

No error boundary, no crash — a *healthy* page reporting empty ancestors. That
is exactly what a broken resolvability gate would look like, and it cost a wrong
"possible product bug" call before the timeline was checked.

Two details that make it recognisable:

- **It is gradual, not instant.** `resetSetBuilderData` deletes in batches, so
  columns empty one after another over ~45s while earlier steps keep passing.
  A column that already rendered (Manufacturers above) can still show stale rows.
- **Later steps fail, earlier ones passed.** In the incident the set row was
  tapped at 17:22:32 and the attributes panel resolved twice more (17:22:58,
  17:23:13) before Years went empty at ~17:23:21.

## The check, before diagnosing anything

```bash
gh run list --branch <branch> --limit 2 --json databaseId,headSha,status,createdAt
gh run view <id> --json jobs --jq '.jobs[] | select(.name|test("E2E")) | "\(.name) \(.status) \(.startedAt)"'
```

Compare the `E2E / seed` `startedAt` (UTC) against your flow's wall-clock window
in `maestro.log` (local time). In the incident seed started `22:22:35Z` = 17:22:35
local — the exact minute the teardown began.

## The rule

**Do not run against a PR preview while a CI run is in flight**, and re-check
after any push: a push you did not make (a teammate agent's) starts a run that
will reset the deployment. Conversely, never start a local `setup` while CI's
runners are draining — the same collision in the other direction (see
[[feedback_never_push_a_branch_convex_to_shared_dev]] for why the preview is the
right target in the first place, and
[[reference_ci_convex_preview_starts_empty]] for what the seed job actually does).
