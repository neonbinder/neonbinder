---
name: feedback_never_push_a_branch_convex_to_shared_dev
description: Never `convex dev`/`deploy` a branch's functions onto shared dev to unblock a local E2E run — point a spare-port Vite at the PR's own Convex preview instead, and seed it by running the setup track
metadata:
  type: feedback
---

**Do not push a branch's Convex functions to shared dev to
make a local Maestro run possible.** Point a Vite on a SPARE PORT at the PR's
own Convex preview deployment and run the flows against that; the preview
starts empty, so seed it by running `setup` against it exactly as CI's `seed`
job does.

**Why:** shared dev is whatever branch pushed last. A branch push removes or
changes functions every other agent's local Vite is calling, and mutates data
three other worktrees may be mid-run against; the PR preview already carries
the branch's own functions and needs no deploy. Reaffirmed by the coordinator
on 2026-09-04 (NEO-239) and by the user-scope memory
`validate-e2e-locally-against-the-pr-preview` (NEO-214, 2026-09-04).

**How to apply:** when `npx convex function-spec` shows shared dev is missing a
function the page mounts unconditionally, that is a signal to ask for the PR
preview URL — **not** a signal to push. This holds even when the tree is clean
at `origin/main` and the push would only bring dev *forward*: it is still a
write to a deployment you do not own, and it can fail schema validation against
another in-flight branch's rows.

**Stale note to distrust:** the monorepo-tracked
`.claude/agent-memory/maestro-e2e-author/project_local_validation_needs_a_pr_preview.md`
has an "Update 2026-09-03 — the sanctioned local push" section citing
`e2e-local-stack.sh`'s opening `npx convex dev --once` as a documented
workflow. That script is for a session that owns the machine end to end; it is
NOT licence to push while other agents are working. Same for the wrapper-repo
note `reference_local_validation_monorepo_worktree`.
