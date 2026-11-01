---
name: feedback-no-local-convex-deploy-from-worktrees
description: Never run convex dev/deploy from a feature worktree; validate schema changes via tsc + the PR's isolated Convex preview
metadata:
  type: feedback
---

Do not run `npx convex dev` / `npx convex deploy` from a feature worktree, and do not create a `.env.local` there.

**Why:** feature worktrees are deliberately left without Convex credentials so a schema change can't be pushed to a shared dev/prod deployment from a branch. Each PR gets its own isolated Convex preview deploy in CI — that is the intended validation surface for schema and backend changes.

**How to apply:** validate locally with `tsc -p convex/tsconfig.json` only (see [[reference-typecheck-convex-changes]]), then let the PR's preview deploy prove the schema. Read-only `npx convex` commands against an already-configured deployment are fine; anything that writes is not.
