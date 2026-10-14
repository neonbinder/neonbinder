---
name: feedback-never-stage-when-told-not-to-commit
description: When asked to make changes but NOT commit, delete files with plain `rm`, never `git rm` — a sibling agent's concurrent commit sweeps up anything staged
metadata:
  type: feedback
---
When the task says "do NOT commit", do not put anything in the git index
either. Delete files with `rm`, not `git rm`, and never `git add`.

**Why:** NeonBinder work is split across parallel agents in ONE worktree (app
code, tests, E2E specs). On 2026-09-05 I staged six deletions with `git rm`;
~90 seconds later the sibling app-code agent ran its own commit and the staged
deletions landed inside an unrelated feature commit. Nothing was lost, but the
deletions ended up attributed to the wrong change, and had my edits been staged
too they would have shipped half-reviewed.

**How to apply:** in any shared worktree, keep your work UNSTAGED until the
coordinating agent commits it. `git status --short` disappearing entries is the
tell that someone else committed underneath you; check `git log -1` before
concluding your own change vanished. Never `git stash` or `git add -A` there
either.
