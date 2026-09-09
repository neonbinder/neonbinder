---
name: feedback_concurrent_agent_commit_scoping
description: When another agent shares this worktree, `git commit -m` after `git add <paths>` still commits their pre-staged files too — use `git commit -F <msgfile> -- <paths>` instead
metadata:
  type: feedback
---

When the coordinator runs multiple agents concurrently in the SAME worktree
(e.g. unit-test-author + accessibility-auditor both editing
`apps/web/components/**`), the git index is shared. `git add <my paths>`
stages only what you ask, but a plain `git commit -m "..."` commits the
**entire index**, including files another agent already staged with their own
`git add` — even files you never touched and that may contain a failing
work-in-progress test.

**Why it matters:** on NEO-208, I ran `git add <5 files>` then
`git commit -m ...` and the resulting commit picked up three extra files
(`CardChecklist.tsx`, `CardDetailPanel.tsx`, `TeamPicker.tsx`) that the
accessibility-auditor had already staged concurrently — one of which carried
a test that was still failing (their WIP). `git status --porcelain` after the
`git add` clearly showed those three as `M ` (staged) even though I never
added them; I missed that signal.

**How to apply:** when a task says "stage only your own files," don't trust
`git add <paths>` alone to bound the commit — check `git status
--porcelain` right before committing and confirm nothing unexpected shows
`M ` (staged, first column) that you didn't add. Then commit with an explicit
pathspec so the commit itself is scoped regardless of what else sits in the
index:

```bash
git commit -F <msgfile> -- <path1> <path2> ...
```

(`-m` must come before `--`, so a multi-paragraph message needs `-F` with the
message in a temp file — `git commit -m "..." -- <paths>` also works if the
message is a single `-m` argument, but `-F` is cleaner for a long body.)

If a bad commit already happened, `git reset --soft HEAD~1` undoes the commit
while leaving the index exactly as it was (so the other agent's staged files
stay staged for them), then recommit scoped correctly.

See also [[project_neo208_shared_helper_test_patterns]] for the substantive
test content from this same session.
