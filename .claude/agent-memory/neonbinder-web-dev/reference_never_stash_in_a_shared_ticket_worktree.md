---
name: reference-never-stash-in-a-shared-ticket-worktree
description: Parallel builders edit ONE ticket worktree at the same time, so `git stash` there reverts colleagues' uncommitted work; baseline-check a test by another route
metadata:
  type: project
---

Several builder agents run **concurrently in the same ticket worktree**. Their
uncommitted edits are all in that one working tree, and the git stash stack is
shared with every other worktree and the main checkout.

**Why:** on NEO-296 I stashed (`git stash push -u`) for ~20 seconds to see
whether a red test was red at baseline. That reverted another builder's
in-flight edits to seven files (`placeholderPipeline.ts`, `players.ts`,
`teams.ts`, `bulkLoad.ts`, `setReconciliation.ts`, `teamFill.ts`,
`entityReviewQueue.ts`) plus a new untracked module. `git stash apply <sha>`
restored everything and they had written 129 more lines meanwhile, which merged
cleanly — but only by luck, and any tool call they made in that window read a
file that had silently rolled back.

**How to apply:** to tell "my change broke this" from "it was already red",
never stash and never `git checkout --`. Instead:
- `git stash` is out and so is a WIP commit (builders must not commit).
- Read the baseline out of git without touching the tree:
  `git show HEAD:apps/web/convex/<file>.ts > /tmp/scratch/base.ts` and compare,
  or check whether the failing file is one **you** edited at all —
  `git diff --stat <path>` answers that in one call.
- If a red test lives in files you never touched, it is not yours: name it in
  the report as a concurrent builder's and move on.

Related: [[gates-in-a-shared-worktree]].
