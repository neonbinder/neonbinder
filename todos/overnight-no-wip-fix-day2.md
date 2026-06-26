# PR #26 overnight day 2 — real-fix campaign (no-wip rule)

User went to bed after establishing the hard rule "wip is not allowed."
Goal: turn PR #26 green by fixing the 7 wip'd flows for real, not
suppressing.

## Current state (commit `72d3eb1`, branch `feat/card-checklist-fetch`)

CI on `72d3eb1`: **4 failures, down from 7 at start of session.**

Failures:
| Flow | Symptom |
|---|---|
| `cascade/sets-parallels` | `Reconcile Variants` not visible (sub-variant sync for Topps Chrome Parallel returned 0 — possibly worker race / BSC session) |
| `checklist-fetch-unknown-entities-skip-some` | `Confirm New Players & Teams` dialog not visible after fetch |
| `checklist-keyboard-only-dialog` | Same |
| `checklist-renders-rich-fields` | `BSC` badge not visible (fetch returned 0 cards) |

Tests that newly **pass**: `cards-base`, `checklist-fetch-cancel-dialog`,
`parallel-grouping-cancel-discards`, `parallel-grouping-keyboard`,
`variant-metadata-editor-insert`, plus the entire `cascade/setup`,
`cards-insert`, `cards-parallel`, `cards-parallel-of-insert`,
`sets-move-parallels-of-inserts` chain.

## Blocking issue: Convex deploys are NOT happening via Vercel

`vercel.json:buildCommand` = `npx convex deploy --cmd 'npm run build' || npm run build`.
Without `CONVEX_DEPLOY_KEY` in Vercel preview env, the `convex deploy`
step silently fails and falls back to plain `npm run build`. Confirmed
from the Vercel build log on `72d3eb1` (`dpl_6wCg6pgcs6qaGSs9K221BFipsouu`):
no Convex output between `npm ci` and `vite build`.

**Consequence:** every Convex code change in this session (schema,
addCustomCard players arg, fetchCardChecklist pendingPlayerNames
reconciliation, commitCardChecklist clear-on-confirm, retry-on-503 in
authenticateBsc/Sportlots) is **only landed in the branch source — not
deployed to the dev Convex backend that CI's Maestro tests hit.**

This is why:
- The dialog tests' custom-card preamble isn't triggering the
  UnknownEntitiesDialog (the reconciliation code that reads
  `pendingPlayerNames` isn't on the dev backend).
- BSC login retries on 503 don't appear in Convex logs — the old
  authenticateBsc is still running.

## What the user needs to do (morning)

1. **Set `CONVEX_DEPLOY_KEY` in Vercel preview env** so Vercel's build
   actually deploys Convex on each push.
   - Generate a deploy key via the Convex dashboard:
     `https://dashboard.convex.dev/d/focused-fox-53` → Settings →
     Generate Production Deploy Key (or a preview-deploy key).
   - Add it to Vercel project env (Settings → Environment Variables)
     scoped to Preview + Development.
2. Push an empty commit on `feat/card-checklist-fetch` to retrigger
   the Vercel build with the now-deploy-capable convex command.
3. CI on that commit should pull a fresh Convex deployment that has my
   schema + function changes, and the dialog tests should pass.

## What I did NOT do (and why)

- **Did not push another revision tonight.** The remaining failures
  can't be resolved without the Convex deploy issue fixed first —
  pushing more iterations just spins CI without testing the actual
  product changes.
- **Did not manually `npx convex deploy` more than once.** My one
  earlier manual deploy hit `first-starfish-800.convex.cloud` (not
  `focused-fox-53` — a separate deployment). Per
  `feedback_no_direct_convex_commands`, mutating convex commands
  should go through a project script (`npm run deploy:dev` was
  mentioned in memory but doesn't exist in package.json — that script
  may need to be added).

## Branch commit chain this session

```
72d3eb1 fix(e2e): remove redundant per-worker creds preflight; use digit-prefix custom card numbers
25f1af8 fix(e2e): unbreak setup.yaml pre-sync + handle 503 BSC/SL login race
1aa1d07 ci: retrigger Vercel build for previous push (no deployment was registered)
63e8c4d fix: remove 7 wip tags via real fixes (no suppression)
```

All five fixes from the approved plan are in `63e8c4d`:
1. Schema gets `pendingPlayerNames` / `pendingTeamNames`
2. `addCustomCard` accepts `players` / `teams` args
3. `fetchCardChecklist` reconciliation folds in custom-card pending names
4. `commitCardChecklist` clears confirmed pending names + folds them
   into `allPlayerNames`/`allTeamNames` so confirmed-new resolution
   creates them
5. Add Card UI gets a "Player(s) — comma separated" input
6. `setup.yaml` pre-syncs Topps Update / Topps Pro Debut /
   Topps Wonderland variant types via `runFlow util-drill-to-2024-topps-chrome.yaml`
7. 3 dialog tests add a unique custom card before fetch (digit-prefix
   cardNumber `9001-/9002-/9003-` so cards-base's `#[0-9]` assertion
   still works)
8. Composite end-state wait replaces the fragile transient `Fetching...`
9. All 7 `wip` tags removed

## Wave-by-wave debugging this session

| Commit | Issue surfaced | Fix |
|---|---|---|
| 63e8c4d | First green run never landed | retrigger Vercel via 1aa1d07 |
| 1aa1d07 | setup.yaml's inline "Search sets" tap failed after Topps Chrome was selected (dropdown collapsed) | 25f1af8: replace with `runFlow util-drill-to-2024-topps-chrome.yaml` |
| 1aa1d07 | "BSC login failed" on per-worker preflight | 25f1af8: added retry-on-503 in `authenticateBsc`/`Sportlots` |
| 1aa1d07 | "Player(s)" input below fold of viewport | 25f1af8: `scrollUntilVisible` instead of `extendedWaitUntil visible` |
| 25f1af8 | BSC login still failing (response 200 with success:false, not 503) | 72d3eb1: removed per-worker preflight entirely (workers share Clerk user — preflight redundant + caused the race) |
| 25f1af8 | `cards-base` failed `.*#[0-9].*` (custom card with non-digit prefix sorts first in Virtuoso) | 72d3eb1: changed cardNumber prefixes to `9001-/9002-/9003-` |
| 72d3eb1 | Dialog still doesn't open for the 2 dialog tests | Pending fix — requires Convex deploy chain fix (see top) |

## Key learning (worth saving to memory)

The "workers share the same Clerk user when TEST_EMAIL_n isn't set"
discovery is important. Convex logs at 5:48 AM showed two concurrent
`authenticateBsc` calls for the SAME `user_34Zrwiosv4G6TvZjoH9QJgGF2Un`.
That means CI's preview env only has unindexed `TEST_EMAIL` set —
workers fall back to that single user. Per-worker BSC creds aren't
needed; the cascade setup-done worker saves them once and all workers
share via the common Clerk user / Convex user.

## Recommended follow-up scope for the morning

After fixing CONVEX_DEPLOY_KEY:

1. Push empty commit → wait for green-or-near-green CI.
2. If `cascade/sets-parallels` still fails, look at whether my
   setup.yaml extension (3 extra `util-drill` runs) is exhausting the
   BSC session that subsequent flows need. Possible fix: don't drill
   to `Parallel` variant type in pre-sync — only `Base/Insert/Parallel`
   visibility check, not sub-variant sync.
3. Add a `package.json` script `deploy:dev` and `deploy:prod` that
   honor the memory's expectation — possibly:
   ```json
   "deploy:dev":  "CONVEX_DEPLOYMENT=dev:focused-fox-53 npx convex deploy",
   "deploy:prod": "CONVEX_DEPLOY_KEY=$CONVEX_PROD_DEPLOY_KEY npx convex deploy"
   ```
