---
name: measure-a-fixture-from-ci-artifacts
description: Size a real-set fixture (suggestion counts, marketplace item counts) from a green run's artifacts when no preview exists — convex-logs carry adapter result_count per level; screenshots and error-context.md carry rendered counts
metadata:
  type: reference
---

When a spec needs a data-dependent threshold (e.g. "a Group Parallels plan past
200 entries") and there is no preview to run on, a green CI run of the spec that
already touches the fixture usually has the number:

- **The convex logs artifact** (`convex-logs-runner-0/*.jsonl.gz`):
  `adapter_sync_call` lines carry `level`, `parentSetName` and `result_count` per
  marketplace fetch: how many items BSC / SportLots answered for a set's insert or
  parallel level. Only one runner's deployment log is uploaded, but it is the whole
  preview's log.
- **Rendered counts** (`Accept all suggestions (N)`, `Save N changes`): a spec that
  asserted only a regex over them did not record the number. Read it from the
  failure screenshot / `error-context.md` of a red run, or add a deliberately
  failing probe locally against the PR preview. Traces are NOT an option (they
  record Clerk testing tokens and are never uploaded).

`gh run download <id> -p '<artifact name>'` into the scratchpad; find the shard by
grepping for the spec name.

Group Parallels specifics learned the same way (NEO-308): Accept All only clears
the "suggested" markers; suggestions are PRE-PLACED as promotions at INIT, so
`Save N changes` = the suggestion count, all promotions. And the footer reads `No
changes yet` from the first render (skeleton, before INIT), so a "nothing left to
suggest" assert on a re-open needs a row gate first (a row's `Select <name>` tick,
which every initialised row carries).
