---
name: reference_ci_convex_preview_starts_empty
description: A PR's Convex preview starts with an EMPTY database (no dev clone, no --preview-run seed) and is populated by e2e.yml's seed job running the setup track — so data backfills are a dev/prod concern, never a CI prerequisite
metadata:
  type: reference
---

# CI's Convex preview starts EMPTY — the setup track is the only seed

Evidence, all in-repo:

- `apps/web/vercel.json` → `buildCommand: npx convex deploy
  --cmd-url-env-var-name VITE_CONVEX_URL --cmd 'npm run build'`. **No
  `--preview-run`**, and there is no preview-seed function anywhere in the repo
  (`grep -rn "preview-run\|preview-create"` returns nothing). A Convex preview
  deployment is created fresh; it does **not** clone dev's data.
- `.github/workflows/e2e.yml` job `seed` → `npm run test:e2e -- setup` as
  worker 0 at parallelism 1, before the runner matrix fans out. That is the only
  entry point that runs `setup`-tagged flows (`run-e2e-queue.sh`: "setup is the
  pre-matrix seed, never queued as a worker flow"). It does the global reset and
  then a LIVE BSC/SL sync that creates Baseball → 2024 → Topps → Topps Chrome,
  its Base/Insert/Parallel variant types and their checklists from scratch.

## What follows

1. **A one-shot data backfill is never a CI prerequisite.** Every row in a CI
   preview is created by that first sync, so whatever the backfill repairs must
   ALSO be derived at insert time in the sync path. If a new field is only set
   on the "match existing row" branch and not on "insert", CI breaks even though
   dev looks fine after the backfill. Backfills exist for dev and prod only.
2. **Local runs against SHARED DEV are the opposite case** — dev's rows are old
   and were never re-synced, so a local run needs the backfill or a forced sync.
   Do not read a local failure there as a CI failure.
