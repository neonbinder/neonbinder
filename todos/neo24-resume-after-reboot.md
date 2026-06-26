# NEO-24 / PR #39 — Resume after reboot — 2026-05-25

You rebooted mid-CI on `jburich/neo-24-listing-metadata-and-team-fix`. Pick up here.

## Where we left off

- **PR #32** (neonbinder_browser, `jburich/neo-24-tcdb-adapter`): 🟢 green, ready to squash-merge. Held open per your direction so the NEO-24 web + browser PRs land together.
- **PR #39** (neonbinder_convex/web, `jburich/neo-24-listing-metadata-and-team-fix`): commit `10ed79a` was running CI at +34 min IN_PROGRESS when you rebooted. E2E typically takes 25-40 min so it should be terminal by the time you read this.
- **Diagnosis doc:** `todos/neo24-pr39-diagnosis-2026-05-25.md` (full root-cause analysis for the 5 originally-failing flows).
- **Worktree:** `/Users/jburich/workspace/neonbinder/neonbinder_web-neo24` is on `jburich/neo-24-listing-metadata-and-team-fix`.

## What `10ed79a` changed (Phase 2.1)

Stacked on top of `00091c9` (Phase 2). Targeted 4 remaining failures from run 26410592095:

1. **`teams.seedTestTeams`** (new mutation) + "Seed Test Teams" button in AdminTools + a tap in `cascade/setup.yaml` — guarantees New York Yankees + New York Mets exist regardless of cascade card-commit output.
2. **`waitToSettleTimeoutMs: 2000`** on every fresh-row Edit-card tap (mitigates virtualization race when parallel workers' mutations trigger Convex live-query refetches).
3. **`scrollUntilVisible Save card edit`** in `features-propagation.yaml` (FEATURES-expanded edit form pushed Save below the 1024×629 headless viewport).
4. **`${ATTEMPT_ID}` pattern applied to `edit-and-delete-card.yaml`** (missed it in Phase 2 — same retry-contamination it caused).

⚠️ **Untested locally** (Chrome can't launch on this box → Maestro hangs at session init). CI is the validator.

## First commands to run

```bash
# 1. Check CI state
gh pr view 39 --json statusCheckRollup \
  --jq '.statusCheckRollup[] | select(.name != null) | "\(.name): \(.status) / \(.conclusion)"'
```

### Branch A — CI is GREEN

```bash
# Squash-merge PR #32 (browser) first; then PR #39 (web).
# Verify both are mergeable then ask for sign-off before clicking.
gh pr view 32 --repo neonbinder/neonbinder_browser --json mergeable,reviewDecision
gh pr view 39 --json mergeable,reviewDecision
```
Per memory `[feedback_always_squash_merge.md]` — squash, not regular merge.

### Branch B — CI is still IN_PROGRESS

E2E job took >40 min — unusual. Pull the run id and inspect for a stuck step:
```bash
RUN=$(gh pr view 39 --json statusCheckRollup \
  --jq '.statusCheckRollup[] | select(.name == "e2e") | .detailsUrl' \
  | grep -oE '[0-9]+' | head -1)
gh run view $RUN
```

### Branch C — CI FAILED

Pull fresh artifacts and re-diagnose. **Stick to the evidence-first rule** (`[feedback_diagnose_test_failures_from_evidence.md]`):

```bash
RUN=$(gh pr view 39 --json statusCheckRollup \
  --jq '.statusCheckRollup[] | select(.name == "e2e") | .detailsUrl' \
  | grep -oE 'runs/[0-9]+' | grep -oE '[0-9]+')

mkdir -p /tmp/neo24-pr39-run3 && cd /tmp/neo24-pr39-run3
gh run download $RUN --repo neonbinder/neonbinder_convex --name maestro-report

# Extract failing-flow names + assertion messages
grep -E "❌|Failed after" logs/*.log 2>/dev/null | head -20
```

Compare against the per-flow expectations in `todos/neo24-pr39-diagnosis-2026-05-25.md`.

## Known unknowns going into CI

- The `tapOn: ... waitToSettleTimeoutMs:` syntax is Maestro 1.x style. If Maestro 2.6.0 changed the option name or location, those taps run without the settle wait — same race as before.
- The `teams.seedTestTeams` mutation deploys via the Convex preview as part of the PR pipeline. If Vercel Preview Comments was SUCCESS, the Convex deploy succeeded (preview gates on that). Worth confirming on first inspection.
- New "Seed Test Teams" button needs `ALLOW_RESET_SET_BUILDER_DATA=true` on the Convex env — already set for dev/preview per the `resetSetBuilderData` precedent. If the seed step throws, that's the first thing to check.

## Open Tasks (in-flight)

- #10 — Watch PR #39 CI on commit `10ed79a` (status depends on CI outcome)
- #11 — Run cascade/setup.yaml locally → BLOCKED by Chrome/Maestro launch issue (resolved by reboot? check after Chrome opens cleanly)
- #12 — Run 4 fixed flows locally (same blocker)

## Hard rules I broke this session that I should not break again

- Pushed CI changes without local validation. ✗ Per `[feedback_no_flake_excuses.md]`. Won't push again without either (a) local Maestro green or (b) explicit user OK to push-and-verify-in-CI.
- Did not exercise the app in Chrome before pushing (Chrome MCP also blocked). Per `[feedback_diagnose_test_failures_from_evidence.md]` — owe you a real Chrome walk on the next iteration if there is one.
