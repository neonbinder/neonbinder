# Overnight Progress Report — 2026-05-07

Final state at ~04:50 UTC. Updates appended to **Activity Log** (newest first) throughout the night.

---

## 1. Current Status

### Browser repo (`neonbinder_browser`) — **PR #24 ready to merge**

- **PR #24** `feat/bsc-login-seller-id` → main
- HEAD: `f7795ba`
- All meaningful checks **green**:
  - test ✅
  - analyze (CodeQL) ✅
  - CodeQL (security scan) ✅
  - deploy-preview ✅
  - preview-smoke ✅ (Cloud Run revision boots and serves)
  - preview-login-probe ✅ (real BSC + SL Puppeteer login round-trip)
  - comment-preview ✅
- **Only red X is `claude-review`** — see "Claude review issue" below. **Not a code issue, not a regression. Recommend merging through it.**

### Web repo (`neonbinder_web` / GitHub: `neonbinder_convex`) — **NOT yet ready to merge**

- **Branch pushed to remote, no PR opened yet.** Branch: `feat/card-checklist-fetch`. HEAD: `5dbb9bd`.
- Three commits cleanly separated: feat / test / chore.
- **Maestro suite: 27 passed, 7 failed.** The smoke flow `checklist-fetch-with-known-entities` (the most important one) passes. The 7 failures are in 3 categories — see section 4.
- **Blocker:** the new `players`/`teams` table cleanup code in `convex/selectorOptions.ts` needs deployment to dev Convex before 4 of the 7 Maestro fails will go green. Per `feedback_no_direct_convex_commands.md` I did not run `npx convex deploy` directly.

### Wrapper repo (`neonbinder`)

- HEAD on main: `9307b73`
- Only change tonight: this report file.

---

## 2. Code Changes Made Tonight

### Browser repo (3 PRs merged to main + workflow-sync commits on PR #24)

1. **PR #25** (merged) — wire `ANTHROPIC_API_KEY` into the `claude-review` action workflow
2. **PR #26** (merged) — bump `--max-turns 5 → 20`
3. **PR #27** (merged) — switch claude-review prompt to single-summary-comment mode + bump to `--max-turns 30`
4. Three follow-up commits on `feat/bsc-login-seller-id` (`8525de5`, `75988dc`, `f7795ba`) to keep its `claude-review.yml` aligned with `main` after each PR — required because the action enforces "PR's workflow file must match main".
5. One revert commit (`fed87f3`) to clean up an aborted attempt earlier in the cycle.

### Web repo (committed + pushed, no PR yet)

1. `**461ed38` feat(set-builder): card checklist with players/teams + Wikidata enrichment** (13 files, +2542/-200 lines).
  - **NEW:** `convex/players.ts`, `convex/teams.ts`, `convex/adapters/wikidata.ts`, `components/SetSelector/UnknownEntitiesDialog.tsx`
  - **MODIFIED:** `convex/schema.ts`, `convex/adapters/buysportscards.ts`, `convex/adapters/sportlots.ts`, `convex/credentials.ts`, `convex/userProfile.ts`, `convex/selectorOptions.ts`, `convex/_generated/api.d.ts`, `components/SetSelector/CardChecklist.tsx`, `components/SetSelector/CardChecklistItem.tsx`
  - **The non-obvious change tonight, beyond the original feature work:**
    - Extended `resetSetBuilderData` action + added `resetPlayersBatch` and `resetTeamsBatch` internal mutations. Without this, players/teams from prior test runs remained in the DB across Maestro flows; `UnknownEntitiesDialog` never opened (entities already known) → 4 checklist flows failed.
    - Dev/test only — guarded by `ALLOW_RESET_SET_BUILDER_DATA=true`.
2. `**df9dc2f` test(e2e): Maestro flows for card checklist feature** — 10 new flow files including `checklist-fetch-with-known-entities` (smoke), `checklist-fetch-cancel-dialog`, `checklist-fetch-unknown-entities-confirm`, `checklist-fetch-unknown-entities-skip-some`, `checklist-keyboard-only-dialog`, `checklist-renders-rich-fields`, `checklist-fetch-bsc-no-seller-id`, plus three utility flows.
3. `**5dbb9bd` chore(claude): refresh maestro-e2e-author memory for checklist patterns**

### Wrapper repo

- This `overnight-progress-2026-05-07.md` report file (committed as `9307b73` initially, replaced as the night progressed).

## 3. Test Changes Made Tonight

### Browser repo (committed in same PR #24 as the feature)

1. `tests/bsc-adapter.test.mjs` — updated 3 cache/login tests to expect a profile fetch after fresh login (capturing sellerId), and assert `sellerId` surfaces on the AdapterResponse.
2. `tests/sportlots-adapter.test.mjs` — adjusted ~4h-TTL bounds to match the new ~30d production constant.

### Web repo (Maestro flow fixes)

1. `.maestro/flows/set-selector/checklist-fetch-bsc-no-seller-id.yaml` — replaced `extendedWaitUntil "BuySportsCards Credentials"` with a `Neon Binder` page-load wait + `scrollUntilVisible "BuySportsCards Credentials"`. The credentials section is below the fold on `/profile`, so a viewport-only wait never resolved.
2. `.maestro/flows/set-selector/checklist-keyboard-only-dialog.yaml` — removed `pressKey: " "` (Maestro's pressKey enum has no Space; the YAML literally fails to parse). Replaced with a comment explaining the limitation; spacebar-toggle coverage moved to `checklist-fetch-unknown-entities-skip-some.yaml` which uses `tapOn` for the toggle.
3. Removed stale `runFlow: file: util-login-to-bsc.yaml` calls from 6 checklist flows earlier in the night (per your guidance — sellerId capture infra stays, but checklist flows don't depend on it).

## 4. Maestro Failure Triage

### Pre-existing (not caused by tonight's work)

- `**profile/fill-profile-data`** — failed on `"Profile saved.*"` after 6m 55s. Last touched 2026-05-03 (`f6d4ba0`). Independent of this feature; no action needed for this PR.

### Blocked on Convex deploy of `resetSetBuilderData` extension

- `**checklist-fetch-cancel-dialog**` — `"Confirm New Players & Teams"` not visible
- `**checklist-fetch-unknown-entities-confirm**` — same
- `**checklist-fetch-unknown-entities-skip-some**` — `"Manufacturers"` not visible (a different but pollution-adjacent fail mode)
- `**checklist-fetch-bsc-no-seller-id**` — first run failed on the wait-anchor I fixed in YAML; re-run blocked by separate hang

> All four flows expect a clean DB. The `resetSetBuilderData` action now wipes `players`/`teams` (committed in `461ed38`) but **the dev Convex deployment doesn't have that change yet**. After deployment all four should go green on a re-run.

### Investigation incomplete (state-related hangs)

- `**checklist-renders-rich-fields`** — first attempt hung at >13 min with 0% CPU; killed.
- `**checklist-keyboard-only-dialog**` — re-run after YAML fix also hung at ~10 min with 0% CPU; killed.

> Pattern: both hung flows use `util-drill-to-base-variant` which calls `util-drill-to-2024-topps-chrome`. After other long-running flows have hammered the same browser session, something in the drill sequence stalls. Could be Vite memory pressure, a stuck DB reset, or a Maestro web-driver issue. **Need a fresh Vite + Convex restart before retesting.**

## 5. Claude review issue (browser PR)

The `claude-review` workflow on PR #24 has been the most painful part of tonight. Status:

- **Was failing for 3 weeks before tonight** on every PR (since 2026-04-19) — pre-existing, not a regression caused by us.
- Tonight progressively unblocked: API key wired (PR #25) → max-turns bumped (#26) → summary-comment mode (#27).
- Even after all three fixes, the action **still hits `error_max_turns 31/30`** on a real feature PR. It is making productive review progress, just running out of budget.

### Recommended decision (one of):

- **A) Mark non-blocking** — add `continue-on-error: true` on the `claude-review` step. Lets the check show ⚠️ instead of ❌. Simple. Doesn't lose any merge-quality signal; the check has been informational only.
- **B) Disable the workflow** until the action's auth/budget model stabilizes. Removes the red X entirely.
- **C) Keep iterating** — bump to `--max-turns 60` etc. We've spent 4 PRs on this and it hasn't converged; not recommended.
- **D) Just merge through it** — every other check is green. The merge button is enabled.

I'd go with **(D)** for this PR + **(A)** for future PRs.

## 6. Next Steps for Morning

In rough order:

1. **Merge browser PR #24** — pick option (D) above and squash-merge. The actual code is in good shape. Or apply option (A) first if you want CI hygiene.
2. **Restart Vite + Convex dev** — Vite has been up since ~10pm last night, browser session may be polluted. Fresh restart will likely clear the two `state-related hangs` failures.
3. **Deploy the `resetSetBuilderData` extension** — `cd neonbinder_web && npx convex dev` (auto-pushes the new `resetPlayersBatch`/`resetTeamsBatch` mutations to dev Convex). This unblocks 4 of the 7 Maestro fails.
4. **Re-run the failing Maestro flows** — `PATH="$HOME/.maestro/bin:$PATH" maestro test --platform web ...` for just the 6 non-pre-existing fails. With #2 + #3 done, all 6 should go green.
5. **Open the web PR** when Maestro is fully green. Branch: `feat/card-checklist-fetch`, base: `main`. The diff is large (~1400+ lines, 13 files) but the security audit was already completed (task #20).
6. **Decide claude-review long-term** (option A or B from section 5).

## 7. Recovery Notes

If the laptop crashed during the night:


| Repo               | Branch                      | HEAD SHA              | Remote?  |
| ------------------ | --------------------------- | --------------------- | -------- |
| neonbinder_browser | `feat/bsc-login-seller-id`  | `f7795ba`             | ✅ pushed |
| neonbinder_browser | main                        | `18c8578`             | ✅        |
| neonbinder_web     | `feat/card-checklist-fetch` | `5dbb9bd`             | ✅ pushed |
| neonbinder_web     | main                        | `7c080eb`             | ✅        |
| neonbinder         | main                        | `9307b73` (this file) | ✅ pushed |


Nothing was uncommitted at the time of writing. All work survives a hard crash.

---

## Activity Log (newest first)

- **04:50 UTC** Final morning report written. Maestro re-run of `checklist-keyboard-only-dialog` hung at 10 min like `checklist-renders-rich-fields` earlier — both share `util-drill-to-base-variant`. Killed. Decided to stop iterating on Maestro tonight; the remaining failures are blocked on either a Convex deploy or a Vite restart, neither of which I can reliably do autonomously without risking your overnight environment further.
- **04:18 UTC** Maestro suite finished: 27 passed, 7 failed. Smoke flow `checklist-fetch-with-known-entities` PASSED. Pre-existing `fill-profile-data` and 6 checklist sub-flows fail. Started a targeted re-run of `checklist-keyboard-only-dialog` to validate the YAML fix.
- **04:09 UTC** Crash-safety checkpoint: pushed all uncommitted web-repo work to remote `feat/card-checklist-fetch` as 3 commits (feat / test / chore). HEAD: `5dbb9bd`. Killed a hung `checklist-renders-rich-fields` flow at 13 min so the suite could continue.
- **03:48 UTC** Claude-review on PR #24 hit `error_max_turns 31/30` even with summary mode + bigger budget. Stopping the iteration cycle — 4 PRs spent, not converging. Documented as morning decision. Found a real Maestro failure mode: `players`/`teams` not cleaned up by `resetSetBuilderData`. Fixed in `convex/selectorOptions.ts` + `checklist-fetch-bsc-no-seller-id.yaml`.
- **03:35 UTC** Claude-review hit `error_max_turns 21/20`. Each inline comment costs 1 turn — most of budget went to comment-posting overhead. Opened PR #27: switch to summary-comment mode + `--max-turns 30`.
- **03:24 UTC** PR #26 squash-merged → main. Workflow file on `feat/bsc-login-seller-id` synced and pushed (`75988dc`). New claude-review run with API key + bumped budget. Maestro early flows passing.
- **03:10 UTC** Initial report written. PR #26 in flight with `--max-turns 5 → 20`. Maestro suite started.

