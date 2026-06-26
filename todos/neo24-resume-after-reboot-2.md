# NEO-24 / PR #39 — Resume after reboot #2 — 2026-05-25

Second reboot of the day. Maestro 2.6.0 web kept hanging at SLF4J init (CdpWebDriver session never started) on this Mac. Same symptom as the first resume doc. User: "I'm sure the problem is this mac and I don't want to fix it. let me reboot and then it should work."

## Where we left off

Worktree: `/Users/jburich/workspace/neonbinder/neonbinder_web-neo24`
Branch: `jburich/neo-24-listing-metadata-and-team-fix`
Latest pushed commit on PR #39: `10ed79a` (CI run 26413023164 was red with 3 failures).

## Three uncommitted edits sitting on disk (verified pre-reboot)

```
 M .maestro/flows/set-selector/cards-parallel-custom.yaml          (+1 line:  - requires:setup-done)
 M .maestro/flows/set-selector/variant-metadata-editor-insert.yaml (+1 line:  - requires:setup-done)
 M components/SetSelector/AdminTools.tsx                            (1 line modified)
```

`AdminTools.tsx` change: the button row's render condition went from
```tsx
{status.kind === "idle" && (
```
to
```tsx
{status.kind !== "confirming" && status.kind !== "running" && (
```
so the Seed/Wipe/Reset buttons stay visible when `status.kind === "success"` (after a Reset completes), unblocking `setup.yaml`'s `scrollUntilVisible "Seed Test Teams"`.

## Verified pre-reboot via Chrome walk (against local Vite + Convex dev)

1. Sign in via `/testing/sign-in?redirect=/set-selector&worker=0`
2. Click "Reset Set Builder Data" → type RESET → click "Delete Everything"
3. After "Deleted 853 selector options and 344 card checklist rows" banner: **all 3 buttons (Seed Test Teams, Wipe Legacy Base Children, Reset Set Builder Data) remained visible** ✅
4. Click "Seed Test Teams" → "Seed complete: created 2 new team(s), 0 already existed" ✅

The Convex preview/dev deployment for this branch already has `teams.seedTestTeams` deployed (it was on `focused-fox-53` for my local Convex dev).

## NOT YET verified (the reason for the reboot)

- Local Maestro run of `setup.yaml` — needed per `[feedback_no_flake_excuses.md]`.
- Local Maestro run of `cards-parallel-custom.yaml`.
- Local Maestro run of `variant-metadata-editor-insert.yaml`.

Run all three before pushing. Do NOT push without these passing.

## Resume steps after reboot

```bash
# 1) Vite + Convex dev (use Node 24.3.0 — nvm use)
cd /Users/jburich/workspace/neonbinder/neonbinder_web-neo24
source ~/.nvm/nvm.sh && nvm use   # → v24.3.0
VITE_DEV_DISABLE_HTTPS=1 npm run dev:all
# (Node 22.5.x triggers the vite-plugin-mkcert undici webidl bug.
#  Either nvm-use 24.3.0 OR set VITE_DEV_DISABLE_HTTPS=1 — belt + suspenders.)

# 2) Wait for Vite at :3000 + Convex dev "Convex functions ready".

# 3) Run the 3 flows locally. Headless. Worker 0.
set -a; . ./.env.test; set +a
export APP_URL=http://localhost:3000
export TEST_USERNAME="neontester-local-$(date +%s)"
export WORKER_INDEX=0

PATH=$HOME/.maestro/bin:$PATH maestro test --platform web --config .maestro/config.yaml \
  -e APP_URL=$APP_URL -e TEST_USERNAME=$TEST_USERNAME -e WORKER_INDEX=$WORKER_INDEX \
  -e BSC_USERNAME="$BSC_USERNAME" -e BSC_PASSWORD="$BSC_PASSWORD" \
  -e SPORTLOTS_USERNAME="$SPORTLOTS_USERNAME" -e SPORTLOTS_PASSWORD="$SPORTLOTS_PASSWORD" \
  --headless \
  .maestro/flows/set-selector/cascade/setup.yaml

# Then the same for:
#   .maestro/flows/set-selector/cards-parallel-custom.yaml
#   .maestro/flows/set-selector/variant-metadata-editor-insert.yaml
```

If any of the three flows fails locally, STOP and re-diagnose. Do not push.

## If all three pass locally

```bash
cd /Users/jburich/workspace/neonbinder/neonbinder_web-neo24
git add components/SetSelector/AdminTools.tsx \
        .maestro/flows/set-selector/cards-parallel-custom.yaml \
        .maestro/flows/set-selector/variant-metadata-editor-insert.yaml
git commit -m "fix(e2e): unblock setup.yaml seed step + gate custom flows on setup-done"
git push
```

Then launch `pr-watcher` in the background per `[feedback_always_launch_pr_watcher.md]`.

## Held PR

PR #32 (`neonbinder/neonbinder_browser`, `jburich/neo-24-tcdb-adapter`): 🟢 green, held open per user. Squash-merge AFTER PR #39 turns green and AFTER user sign-off (memory: `[feedback_always_squash_merge.md]` plus the standing "no merges without permission" rule).

## Current run's full failure picture (from 26413023164)

3 distinct failures (down from 5 the prior run):
- `set-selector/cascade/setup.yaml` — Seed Test Teams not visible (AdminTools button-hide bug — fixed in this commit)
- `set-selector/cards-parallel-custom.yaml` — Add custom Parallels/Years not visible (lacked `requires:setup-done`, ran against churning state — fixed in this commit)
- `set-selector/variant-metadata-editor-insert.yaml` — Variant Types not visible (same root cause as above — fixed in this commit)
