# NEO-37 — diagnose two intermittent E2E flakes (2026-05-31, user away)

Crash-recovery log. Times **US Central (CDT, UTC-5)**. Append at every step.

## Task / authority (from user)
- Diagnose why these two set-selector flows fail on first attempt and pass on retry in CI:
  - `.maestro/flows/set-selector/move-parallels-of-inserts-custom.yaml`
  - `.maestro/flows/set-selector/parallel-grouping-accept-and-save.yaml`
- **Permitted to fix + push a PR (NO MERGE)** IF the fix is either: (a) test-only and obvious, or (b) a code bug fixable WITHOUT semantically changing the code. Get to a GREEN PR for the user's review.
- If the fix would be a semantic code change → diagnose, do NOT fix/merge, stop and report.
- Permissions: Chrome for local debugging, npm for local tests, push the PR. **NO merge.**
- Maestro flow edits go through the maestro-e2e-author agent (project rule).

## Setup
- Worktree: `/Users/jburich/workspace/neonbinder-worktrees/neo-37`, branch `jburich/neo-37-e2e-flake-diagnosis`, off origin/main `c4b2654`.
- (Main checkout `neonbinder_web` has an uncommitted `.claude/agent-memory/maestro-e2e-author/MEMORY.md` edit + untracked `.claude/worktrees/` — left alone.)
- Flaky-run refs: 26698453694 (#42 original), 26718608519 (#42 post-#44). Both show "Passed on retry" for these flows. Retry overwrote failed-attempt debug artifacts, so using CI console logs for failure reasons.

## Progress log
- [~3:32 PM CDT] Worktree + NEO-37 In Progress. Pulled artifacts from run 26718608519.

## DIAGNOSIS (from CI artifacts: maestro.log + ❌ screenshots, both flows had failed-attempt evidence)

### Flow 1: move-parallels-of-inserts-custom — FAILS in `util-drill-to-custom-set.yaml`
- Failure: `scrollUntilVisible Element not found: ".*pg-move-2.*"` (worker 2), ~1m21s in.
- Sequence (maestro.log): drills Football→2026→**real Topps**→Sets; taps "Add custom Sets"; creates `pg-move-2` (modal opens/closes OK); then `scrollUntilVisible ".*pg-move-2.*"` times out.
- **❌ screenshot shows the columns mid-sync: "Syncing Manufacturer Options" / "Year Options" / "Syncing…" loading cards.** The Sets list (with pg-move-2) is hidden behind auto-sync placeholders.
- ROOT CAUSE: the drill taps the **real "Topps" manufacturer** (not custom). Even though Football/2026 is custom, real-Topps re-introduces a BSC/SL marketplace sync at the Manufacturer/Sets level. Under parallel-worker Convex contention that sync is slow / re-fires *after* the set is created, so the just-created custom set isn't rendered when the scroll runs. The `runFlow when "Search sets" visible` branch is also SKIPPED because the column is mid-sync (search input not rendered), dropping to the fallback which can't reach pg-move-2. Self-heals on retry (column already synced/idle).
- NOTE: the util's stated purpose is isolation from marketplace data, yet it taps real Topps — contradicts itself and is the source of the sync. The header comment says real Topps was a deliberate choice ("mirrors proven search-input pattern"), so changing it has blast radius across many flows that use this util.

### Flow 2: parallel-grouping-accept-and-save — FAILS in `util-login-to-bsc.yaml` (credential warming)
- Failure: ~12s in. maestro.log: `scrollUntilVisible "Test Credentials"` (on /profile) doesn't find it for ~5s, then **Maestro framework crash: `[ERROR] CommandFailed: null cannot be cast to non-null type kotlin.Int`** → util-login-to-bsc FAILED.
- **❌ screenshot shows /profile scrolled to the marketplace-URLs/Payment-Handles section — "Test Credentials" is further down and hadn't been reached.** On retry the same scroll eventually found it after ~14s.
- ROOT CAUSE: credential-warming scrolls a long /profile page to "Test Credentials"; under load the page renders/scrolls slowly, and Maestro itself throws an internal `kotlin.Int` cast NPE during scrollUntilVisible (a Maestro 2.x web-driver bug, not our code). Self-heals on retry.

## DECISION: diagnose-and-report, NO fix pushed
Per the user's conditional permission (fix only if **obvious test-only** OR **non-semantic code**), neither qualifies:
- Flow 1's real fix = stop the marketplace sync in the drill (use a custom manufacturer so the subtree is fully custom) — a shared-util redesign with blast radius across many flows, contradicting a documented decision; OR reduce backend sync contention (app/infra). Band-aiding timeouts/adding "wait for Syncing to clear" is unverifiable without load and papers over the cause (violates no-flake-excuses).
- Flow 2's real fix = a Maestro framework bug (kotlin.Int crash) + slow /profile render under load + flaky credential-warming-via-UI. Not fixable in our code without semantic change; the framework crash isn't ours at all.
- Intermittent + load-only: cannot VERIFY any candidate fix is green without the browser service (destabilizes laptop) and many CI runs. A single green run wouldn't prove a fix.

→ Reported to user with evidence + options. NEO-37 In Progress with diagnosis comment.

## [later] User feedback + selector-fact clarification (Flow 1)
- User flagged `.*pg-move-2.*` as an id/css-selector rule violation. VERIFIED it is NOT: the log shows `textRegex=.*pg-move-2.*, idRegex=null` → visible-text match (the set name in the column). The drill's `id:` selectors bind to **aria-labels** (EntityColumn.tsx:157 `aria-label={\`Add custom ${...}\`}`), i.e. accessibility-perceivable, per our documented `id:"<aria-label>"` convention. Flow + util use ONLY text + id(aria-label); no css/data-testid/idRegex. → Flow 1 complies with the visible/accessibility rule. Real cause stands: the Sets column was mid marketplace-sync, so the visible set text wasn't on screen.
- `util-drill-to-custom-set` is used by 9 flows (blast radius): cards-insert-custom, cards-parallel-custom, cards-parallel-of-insert-custom, move-parallels-of-inserts-custom, parallel-grouping-{accept-and-save,cancel-discards,reject-parallel,suggestions}, variant-metadata-editor-insert.

## PLAN for Flow 1 (proposed, awaiting user go-ahead)
Root cause confirmed (sync hides just-created set). Proposed: make the drill path FULLY custom — add a **custom manufacturer** instead of tapping the real "Topps" — so the custom-subtree auto-sync gate short-circuits (no BSC/SL marketplace sync), the set appears immediately, no "Syncing…" race. Matches the util's own stated isolation goal; real-user-faithful.
- STEP 1 (confirm, Chrome — user authorized): drill Football→2026 locally, observe exactly which step shows "Syncing … Options" and whether a fully-custom manufacturer short-circuits the sync (vs real Topps). No browser service / no marketplace login.
- STEP 2 (fix): if confirmed, maestro-e2e-author switches the util's manufacturer level to custom-add; audit all 9 consumers (none appear to need Topps to be a real marketplace mfr).
- STEP 3: push PR, run CI (several times, intermittent) to confirm green. NO MERGE.
- If STEP 1 shows the gate wrongly syncs even for a fully-custom subtree → that's an app gate bug; reassess.

## [later] CORRECTED ROOT CAUSE (user pushed on "why load? we must scale to many users / load was moved to setup")
Read the actual sync gate. Findings:
- `EntityColumn.tsx:74-84`: auto-sync fires ONLY when a column is EMPTY (`items.length === 0`). Non-empty (pre-synced) columns NEVER sync. → For REAL users on the pre-synced catalog, navigation fires ZERO marketplace calls. The design scales; user's intent holds.
- `convex/selectorOptions.ts:2158-2170`: the custom-subtree gate skips BSC/SL for custom subtrees **except `level === "manufacturer"`** (manufacturers are a static, sport/year-independent SL list, intentionally fetched even for custom subtrees).
- `cascade/setup.yaml` pre-syncs ONLY the real Baseball→2024→Topps→Topps Chrome path. It does NOT pre-load the synthetic **Football/2026** test path.
- ⇒ ROOT CAUSE: the custom Football/2026 path's Manufacturers column is empty and NOT pre-loaded by setup, so the FIRST parallel flow to touch it triggers `fetchAggregatedOptions(manufacturer)` (SL fetch) — and with no server-side dedup, multiple workers hitting the shared-but-empty Football/2026 node at once thundering-herd → "Syncing Manufacturer Options" + reactive churn → the `scrollUntilVisible pg-move-2` race. NOT a real-user scaling bug; a gap where a synthetic test path isn't pre-warmed in single-threaded setup like the real cascade.
- My earlier "use a custom manufacturer" idea was WRONG: manufacturer is gate-exempt and the empty column auto-fetches before anything is added.

## REVISED PLAN for Flow 1 (the real fix — aligns with "load belongs in setup")
Pre-warm **Football → 2026** in single-threaded `cascade/setup.yaml` (one navigation → the manufacturer SL fetch happens there, cached globally). Then all 9 custom-set flows find a non-empty Manufacturers column → no parallel-phase sync → no thundering herd → no race. Test-infra change (setup.yaml), delegate to maestro-e2e-author. Optional separate hardening: server-side dedup/global-cache the static manufacturer list so empty manufacturer columns can't herd.

## STATUS: flow-1 pre-warm IN PROGRESS
- Background agent `ab52bf69b4180aa92` (maestro-e2e-author) editing `cascade/setup.yaml` to pre-warm Football→2026 single-threaded. Reports back (no commit); I review + commit + push + CI.

## Flow 2 (parallel-grouping-accept-and-save) — SAME root cause; plan
- Flow 2 is PURE CUSTOM after the drill (adds Stars/Stars Gold/Stars Red inserts, Group Parallels, Accept All, Save — NO marketplace calls). Its only marketplace touch is the drill's manufacturer sync.
- It runs `util-login-to-bsc` + `util-login-to-sportlots` (credential WARMING) SOLELY to survive that manufacturer sync's potential cold login (per its own comment, lines 44-51). **The flow-2 failure happened INSIDE that warming**: `util-login-to-bsc` scroll to "Test Credentials" on the long /profile page was slow under load + Maestro framework crash (`null cannot be cast to non-null type kotlin.Int`).
- ⇒ Once flow-1 pre-warms Football/2026 manufacturers in setup, the drill makes NO marketplace call → the warming is UNNECESSARY → remove it → the flaky "Test Credentials" scroll + Maestro crash site is gone.
- Scope: only 2 of the 9 custom-set flows warm creds — `parallel-grouping-accept-and-save` AND `variant-metadata-editor-insert` (identical pattern). The other 7 already don't warm (they rely on worker-bootstrap + now the pre-warm). Remove warming from those 2 for consistency.
- KEEP warming in: worker-bootstrap, setup, and all cascade/cards-*/sets-* + checklist-fetch-cancel + set-selector-smoke (those fetch REAL marketplace data → legitimately need warm creds).
- Residual: the Maestro kotlin.Int crash is a framework bug we can't fix in our code; removing the long /profile scroll removes its trigger.
- PLAN: in the SAME NEO-37 PR (after flow-1 pre-warm lands in it), maestro-e2e-author removes `util-login-to-bsc` + `util-login-to-sportlots` from parallel-grouping-accept-and-save.yaml (+ variant-metadata-editor-insert.yaml). CI validates both changes together over several runs. NO merge.

## EXECUTION (combined NEO-37 PR — flow 1 + flow 2)
Decision (user granted branch-decision latitude, no merge): bundle flow-1 + flow-2 into ONE NEO-37 PR; CI validates the whole story in one run.
- [done] Reviewed flow-1 setup pre-warm (142 lines, pure addition, idempotent, setup-done intact, asserts Topps present). **Committed `d9b6e33`** on branch jburich/neo-37-e2e-flake-diagnosis (worktree, not yet pushed).
- [in progress] Background agent `a67779136f7ce8eef` (maestro-e2e-author) removing dead credential warming from parallel-grouping-accept-and-save.yaml (+ verifying/removing from variant-metadata-editor-insert.yaml). Reports back (no commit).
- [done] Flow-2 de-warming agent reviewed (clean diffs: removed util-login warming from parallel-grouping-accept-and-save + variant-metadata-editor-insert; fixed stale comment; no util-login refs left). **Committed `bb3d6c3`**.
- [done] Pushed branch (2 commits: d9b6e33 pre-warm, bb3d6c3 de-warm). **Opened PR #45** (base main), linked to NEO-37.
- [in progress] CI watcher `bqe2fcqw1` armed on PR #45 (→ `/tmp/pr45-watch.txt`). e2e ~38min.
## CI RESULT (run 26729106002, ~8:15 PM CDT): suite "green" (54 passed/0 failed) BUT:
- ✅ `parallel-grouping-accept-and-save` — PASSED FIRST ATTEMPT → **flow 2 FIXED** (de-warming removed its only failure site; not luck — the failing step no longer exists).
- ✅ `variant-metadata-editor-insert` — passed first attempt.
- ❌ `move-parallels-of-inserts-custom` — **STILL "Passed on retry"** (same `No visible element found: ".*pg-move-2.*"`). **Flow 1 NOT fixed.**

### Flow 1 — corrected mechanism (from run-26729106002 maestro.log)
- Pre-warm WORKED: at 00:52:42 the "Search manufacturers" input was present + "Topps" found instantly — NO manufacturer sync during the drill. (So the pre-warm + de-warming are valid wins.)
- Set created + VISIBLE: `assertVisible ".*pg-move-2.*"` PASSED at 00:53:03.4.
- Then `runFlow when ".*Search sets.*" visible` polled ~7s and SKIPPED (00:53:10.5).
- By 00:53:12 the fallback `scrollUntilVisible pg-move-2` → NOT FOUND; ❌ screenshot shows columns back in "Syncing … Options".
- ⇒ ROOT CAUSE (flow 1, remaining): ~9s AFTER the set is created+visible, the shared Football/2026 cascade columns **spuriously RE-SYNC** (EntityColumn auto-sync re-fires — likely the column remounts on a reactive update under parallel-worker writes to the shared Football/2026 nodes, resetting `autoSyncedRef`), replacing the Sets list with the "Syncing" form and hiding pg-move-2. NOT the manufacturer-during-drill sync (that's fixed). Same CLASS as NEO-36 (reactive re-render churn), at the cascade-column level.

### DECISION: stop & report (per user's fix-only-if-obvious/non-semantic rule)
Flow 1's remaining fix is a deeper app-reactivity change (stop the cascade columns re-syncing after they were populated, under reactive churn) — NOT obvious test-only nor clearly non-semantic. Band-aiding (wait-for-not-Syncing before scroll) papers over it and is unverifiable without load. So: stop, do NOT band-aid, report to user.
- PR #45 = real PARTIAL win (flow 2 fixed + manufacturer-during-drill sync eliminated + dead warming removed). Flow 1 still retry-passes → PR does NOT fully close NEO-37. NO MERGE (no permission; user reviews).

## CORRECTION (user pushed: "how do workers cause each other to sync? each uses its own custom")
RETRACTING the "parallel workers cause each other to re-sync" claim — NOT proven and doesn't fit:
- Data model: each worker's SET is unique; Football/2026/Topps are SHARED nodes; so the Sets column (children of shared Topps) is shared and DOES get cross-worker reactive updates — but those ADD items (length>0) so they can't trip the auto-sync gate (fires only on length===0), and they wouldn't touch the Manufacturer/Year columns at all. Yet the ❌ screenshot shows Manufacturer + Year columns "Syncing" — so the trigger is NOT cross-worker set churn.
- PROVEN: set created+visible (assertVisible 00:53:03) → ~9s later gone, multiple columns "Syncing" → a cascade re-render/REMOUNT (resets EntityColumn autoSyncedRef + restarts items query → transient empty → auto-sync re-fires) is the likely shape. TRIGGER UNCONFIRMED (could be this worker's own reactive update, a remount, or load — not established).
## LOCAL CHROME REPRO RESULTS (instrumented EntityColumn mount/unmount + auto-sync + items logs; 1024×629; local→dev convex+browser)
- Drilled Football→2026→Topps (all cached on dev: 122 years, 14 mfrs, 10 sets). EVERY column went undefined→data, mode=idle. NO auto-sync fire, NO remount.
- Created a custom set (UI): Sets column 10→11, mode=idle. **NO re-sync, NO remount, NO transient-empty on ANY column.** → SINGLE-USER IS CLEAN.
- Simulated concurrent load: **15 rapid writes to the shared Topps Sets node** via convex client. Result: Sets column len just counted up; **NO MOUNT/UNMOUNT, NO AUTO-SYNC FIRE, NO len=0/undefined** on any column. → shared-node reactive CHURN does NOT cause the re-sync.
- ⇒ RULED OUT: single-flow bug; cross-worker shared-data churn (my earlier retracted theory — now empirically disproven too).
- ⇒ REMAINING (consistent w/ evidence, NOT reproducible single-machine): the CI ❌ shows Year + Manufacturer + Sets ALL "Syncing" simultaneously → a FULL CASCADE RELOAD (all queries reload at once → empty columns auto-sync). Most likely a Convex **websocket reconnect / session blip under 9-worker backend load** (cf. NEO-36 testing.ts note about reconnects dropping responses). Needs real CI-scale load to repro; can't on one machine.

### Fix implications (all need user's call — none is obvious test-only/non-semantic)
1. Harden EntityColumn so a column that has ALREADY synced/populated doesn't re-fire auto-sync on a transient reload (e.g., persist "synced" beyond the per-instance autoSyncedRef; or don't drop a populated column to "sync" on a transient empty). App-reactivity change.
2. Reduce load-induced reconnects (backend/scale) — infra.
3. Accept the Maestro retry for now (self-heals).

### Cleanup / housekeeping
- Instrumentation reverted (git checkout EntityColumn.tsx; tree clean).
- DEV POLLUTION: created ~16 throwaway custom sets (neo37repro1, flood-0..14) under Football/2026/Topps + 1 custom manufacturer (neo37mfr) under Football/2026, on DEV. No per-row delete mutation exists (only the all-wiping "Reset Set Builder Data"), so left in place — synthetic test path, dev-only, does NOT affect real data or the preview-based E2E. Flag to user.
- PR #45 unchanged (flow 2 fixed; flow 1 = load-induced flake, deeper fix is user's call).

## WRAP-UP (user: ship #45, accept retry, log + Low priority, merge if green) — 9:03 PM CDT
- PR #45 was green (run 26729106002) + MERGEABLE/CLEAN → **squash-merged** (mergedAt 02:03:55 UTC). main = `6ed25ab`.
- NEO-37 → **Backlog + Low priority** + decision comment (flow 2 fixed; flow 1 = load-induced cascade-reload retry-flake, deferred; root cause + 3 fix options recorded). Tracked, not Done.
- Cleanup: neo-37 worktree removed, merged branch `jburich/neo-37-e2e-flake-diagnosis` deleted. No open PRs.
- OUTSTANDING: dev test-data pollution (~16 throwaway custom sets + 1 mfr under Football/2026 on DEV) — no per-row delete API; left in place (synthetic path, dev-only, no effect on real data or preview E2E). User can wipe via dev "Reset Set Builder Data" if desired.
- Local `neonbinder_web` checkout still on stale main (+ pre-existing uncommitted agent-memory edit) — `git checkout main && git pull` to sync to 6ed25ab when ready. ← COMPLETE
