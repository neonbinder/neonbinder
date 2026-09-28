---
name: measure-a-fixture-from-ci-artifacts
description: Size a real-set fixture (suggestion counts, marketplace item counts) from a green run's artifacts when no preview exists — maestro.log tap lines carry the matched node's full text; convex-logs carry adapter result_count per level
metadata:
  type: reference
---

When a flow needs a data-dependent threshold (e.g. "a Group Parallels plan past
200 entries") and there is no preview to run on, a green CI run of the flow that
already touches the fixture usually has the number:

- **`maestro-report-runner-N/debug/<flow>/maestro.log`** — every `tapOn` logs
  `Tapping on element: UiElement(treeNode=TreeNode(attributes={text=…, bounds=…,
  resource-id=…}` with the node's ACTUAL text, even when the flow matched it by
  regex. `grep -o "Accept all suggestions ([0-9]*)\|Save [0-9]* changes"` read
  the real counts off a flow that only ever asserted `.*[0-9]+ .*`.
  `copyTextFrom` does NOT log the copied value — and `commands.json` holds none
  either — so a count only a copy read is lost; a count on something TAPPED is not.
- **`convex-logs-runner-0/*.jsonl.gz`** — `adapter_sync_call` lines carry
  `level`, `parentSetName` and `result_count` per marketplace fetch: how many
  items BSC / SportLots answered for a set's insert or parallel level. Only
  runner 0's deployment log is uploaded, but it is the whole preview's log.

`gh run download <id> -p 'maestro-report-runner-*' -p 'convex-logs-runner-0'`
into the scratchpad; find the runner by grepping for the flow name.

Group Parallels specifics learned the same way (NEO-308): Accept All only
clears the "suggested" markers — suggestions are PRE-PLACED as promotions at
INIT, so `Save N changes` = the suggestion count, all promotions. And the
footer reads `No changes yet` from the first render (skeleton, before INIT), so
a "nothing left to suggest" assert on a re-open needs a row gate first
(`id: "Select .+"`, the tick every initialised row carries).
See [[neo300-grouping-multi-select]].
