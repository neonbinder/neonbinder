---
name: no-prettier-config-in-apps-web
description: apps/web has no prettier config and files are not prettier-formatted; `npx prettier --write` on one file rewrites hundreds of untouched lines
metadata:
  type: reference
---

apps/web (and the monorepo root) carry no `.prettierrc`, and the source is hand-formatted, not prettier-clean. Running `npx prettier --write <file>` applies prettier defaults and reformats every line it disagrees with — on a 565-line component it turned a ~200-line change into a 428-line diff.

**Why:** the diff is reviewed by the coordinator and auditors; formatting churn buries the real change and collides with sibling builders editing the same file.

**How to apply:** never run prettier in apps/web. Match the surrounding style by hand; eslint (`npx eslint <files>`) is the only formatter-ish gate. If it already happened, restore your own file from `git show HEAD:<path>` and re-apply the edits (never `git checkout --` in a shared worktree — see [[reference_never_stash_in_a_shared_ticket_worktree]]).
