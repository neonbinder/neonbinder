---
name: feedback-reviewing-a-live-worktree
description: When auditing a monorepo worktree, another agent may be editing it concurrently — never temporarily overwrite a file to test something, and re-run lint/tests before reporting failures
metadata:
  type: feedback
---

A worktree handed over for security review is often still being edited by the
implementing agent in parallel. Two consequences:

- **Never temporarily overwrite a file** (e.g. checking out the HEAD version to
  compare lint output, then restoring). The restore silently reverts anything the
  other session wrote during the window. Use `git show HEAD:path > /tmp/copy` and
  lint the copy via `--stdin`/a temp path instead of touching the worktree file.
- **Re-run lint and unit tests immediately before reporting.** Failures seen
  mid-review are frequently the other session's in-flight state, not the branch's.
  Confirm which files `git status --porcelain` shows as modified but that you did
  not touch, and re-run before attributing a failure to the branch.

**Why:** during the NEO-147 review (2026-08-13) a lint error and a unit-test failure
both appeared in files this agent never edited; both were gone on a re-run minutes
later once the implementing agent finished.

**How to apply:** at the end of any review that ran a build/test command, re-run it
and report the counts from that final run, noting which modified files were not
yours.
