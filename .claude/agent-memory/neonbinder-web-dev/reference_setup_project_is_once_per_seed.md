---
name: setup-project-is-once-per-seed
description: Re-running the Playwright `setup` project on an already-seeded per-worktree deployment fails at "No manufacturers available" by design; it is not a red to fix
metadata:
  type: reference
---

The `setup` project (playwright/tests/setup.spec.ts) is once per seed: it expects an
empty Set Builder ("No manufacturers available. Sync from marketplaces to populate.")
and builds the shared sets from there. On a per-worktree deployment that was seeded
and set up in an earlier round, a second `--project=setup` run reds on that wait
(45 s) with the Manufacturers column already full. Nothing is wrong with the branch.

**How to apply:** after `agent-convex.sh` (no `--seed`) pushes new code, run only
`--project=bootstrap` for the worker, then the specs. Run `setup` again only after a
`--seed` reset. Specs that build their own data (the demo, a spec seeding its own
order) do not need it at all. Say in the report that setup was skipped and why.

Related: [[gates-in-a-shared-worktree]], [[reference_fresh_worktree_missing_env_local]].
