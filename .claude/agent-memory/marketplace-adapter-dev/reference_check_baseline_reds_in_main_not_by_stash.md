---
name: check-baseline-reds-in-main-not-by-stash
description: When a full vitest run shows a red outside your files, prove it pre-existing by running that one file in the main/ reference checkout — never git stash in a worktree other builders share
metadata:
  type: reference
---

Parallel builders share one worktree, so `git stash` (or checking out the
base) to test "was this red before me?" would yank their in-progress edits
too. `main/` sits on the same base commit and has its own `node_modules`, so
run just that file there: `cd <root>/main/apps/web && npx vitest run <file>`.
It writes nothing tracked. Report the red as pre-existing with the file name
and do not fix it if it is outside your assignment.

Confirm first that `main/` really is at the worktree's base
(`git -C main log --oneline -1` vs the worktree's merge-base); if it has moved,
the comparison proves nothing.

Related: [[a-green-suite-can-mean-the-test-stopped-testing]] for the opposite
check (proving a green suite still covers your change).
