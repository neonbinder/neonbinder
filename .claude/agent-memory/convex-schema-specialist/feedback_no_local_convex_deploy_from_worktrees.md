---
name: feedback-no-local-convex-deploy-from-worktrees
description: Never `convex deploy` from a worktree; the only push from a branch is `npx convex dev --once` to shared dev, from a branch merged up to main, so its specs run before the first push (NEO-390)
metadata:
  type: feedback
---

Never run `npx convex deploy` from a feature worktree: with no deploy key it
targets production. The one push a branch makes is `npx convex dev --once` to
the shared dev deployment, so the covering specs run on dev before the first
push (NEO-390, 2026-10-29; root CLAUDE.md, "Run your specs against dev before
the first push"). This replaces the earlier rule that a branch never pushes
to dev.

**Why:** dev is shared by every concurrent session and whoever pushed last owns
it, and Convex validates every stored row against the incoming schema.

**How to apply:** validate a schema change with `tsc -p convex/tsconfig.json`
first (see [[reference-typecheck-convex-changes]]). Then merge `origin/main`
into the branch and push it to dev. If dev refuses it (`Schema validation
failed` on another branch's rows), never clear data or set `schemaValidation:
false`: report it and validate on the PR's Convex preview instead.
