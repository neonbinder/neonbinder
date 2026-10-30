---
name: feedback_run_specs_on_dev_before_first_push
description: Run the covering specs against shared dev BEFORE the first push, bringing dev up to date first (merge main, `npx convex dev --once`); the PR preview is only for a red dev cannot reproduce (NEO-390, reverses the old never-push-to-dev rule)
metadata:
  type: feedback
---

**Run the specs covering a change against the dev Convex deployment before the
branch is pushed. If dev is out of date, bring it up to date first.** The user
set this on 2026-10-29 (NEO-390) after a thread planned to "run the new spec
locally against the PR preview" once CI was running, which made CI the first
check. It replaces the earlier rule (NEO-214, NEO-239) that a branch must never
be pushed to shared dev. The order is in the root CLAUDE.md, "Run your specs
against dev before the first push".

**Why the old rule existed, and still shapes how you push:** dev is whatever
branch pushed last, and every concurrent session calls it. So:
- Merge `origin/main` into the branch first. Never push a branch behind main.
- Push (`npx convex dev --once`) right before the run. If the page collapses
  to "An error occurred. Please refresh the page." mid-run, another session
  moved dev: merge main and re-push.
- A `Schema validation failed ... extra field` refusal means another branch's
  rows are on dev. Never clear data or set `schemaValidation: false`: report
  it and run against the PR preview after the first push.
- Never run the seed's reset on dev without saying so first: it wipes dev
  under every session. Fresh-only specs go to the PR preview instead.

**How to apply:** check with `npx convex function-spec` what dev has
([[patterns_check_dev_function_spec_before_local_run]]), push if it lacks what
the spec reaches, run on a spare-port Vite with a test account no one else is
using (8–11; CI uses 0–7 on previews). Use the PR preview only when dev cannot
reproduce a red: a `services/browser` or `services/preprocess` change, a refused
schema, or a spec needing a fresh seed
([[project_dev_must_carry_the_branch_before_a_local_run]]).
