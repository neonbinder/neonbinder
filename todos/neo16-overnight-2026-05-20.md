# NEO-16 / PR #32 — overnight log (2026-05-20)

**Goal:** wake up to a green PR #32 ready to merge. No merging tonight — just CI green.

**Worktree:** `/Users/jburich/workspace/neonbinder/neonbinder_web-neo16`
**Branch:** `jburich/neo-16-view-all-sportlots-sets`
**PR:** https://github.com/neonbinder/neonbinder_convex/pull/32

## Plan executed

1. Merged `origin/main` into the branch — auto-merge resolved both overlap files (`convex/selectorOptions.ts`, `cards-parallel-of-insert.yaml`) with no manual intervention. Merge commit `26491b3`.
2. Verified merged files: NEO-22's `isCustomSubtree` gates present in `selectorOptions.ts`; NEO-16's `Inserts`/`Parallels` labels survived in the yaml. Comment block in the yaml now correctly describes the short-circuit path.
3. Pushing merge commit to PR #32 to kick off CI immediately (see timeline).
4. Watching CI; iterating on any failures.

## Local environment notes

- Vite stopped (was running from the stale neo22 worktree) and restarted from this worktree on :3000.
- Node 22.5.1 vs `.nvmrc` 24.3.0 — Convex `npx convex dev` typecheck times out under node 22. CI doesn't use local node, so this only blocks local Maestro debugging, not the CI run we care about.
- Convex dev (`focused-fox-53`) `NEONBINDER_BROWSER_URL` points at deployed Cloud Run; no local browser service needed.
- Per-PR Convex preview deployments are wired (memory `project_convex_preview_deployments_enabled.md`) — CI gets its own Convex backend, doesn't depend on `focused-fox-53`.

## Timeline

(times in local time, 2026-05-20)

- **21:25** — pushed merge commit `26491b3` to `jburich/neo-16-view-all-sportlots-sets`. CI run started: https://github.com/neonbinder/neonbinder_convex/actions/runs/26201740020. Vercel build also kicked off.
- **21:26** — background CI poller running (writes to `/tmp/neo16-ci-poll.log`). Waits until no check is `pending`, then exits.
- **21:29** — Monitor task armed (`ba2tjg7kg`) emits one event per check landing.
- **21:30** — Vercel preview deployment landed `pass`. e2e and Maestro E2E still pending.
- **22:02** — CI terminal: **43 of 44 passed**, 1 failed. Failing flow: `.maestro/flows/set-selector/cascade/cards-custom-subtree-gate.yaml` (the NEW flow NEO-22 added). Error: `Assertion is false: "Variants" is visible`. Retry attempt 2 also failed — same assertion. Root cause: NEO-22 wrote the flow before NEO-16's label rename. The variantType column header is now the pluralized variantType `value`, not the literal "Variants". For a custom variantType `NEO22-CustomVT-N`, the column header is `NEO22-CustomVT-Ns` and the aria-label is `Add custom NEO22-CustomVT-Ns`.
- **22:22** — Pushed fix `9f491df` updating the three hardcoded references in that flow:
  - column header assertion: `visible: "Variants"` → `text: ".*NEO22-CustomVT-${WORKER_INDEX || 0}s.*"`
  - two `id: "Add custom Variants"` taps → `id: "Add custom NEO22-CustomVT-${WORKER_INDEX || 0}s"`
  All other "Variant Types" references (the level-5 column, static label) were left alone.
  New CI run kicked off. Monitor re-armed.
- **22:38** — **All green.** CI run https://github.com/neonbinder/neonbinder_convex/actions/runs/26202956882 — e2e `pass` (33m 17s), Maestro E2E `pass`, Vercel `pass`. `gh pr view` reports `mergeable: MERGEABLE, mergeStateStatus: CLEAN`.

## Final state

| Check | Result |
| --- | --- |
| Vercel preview | pass |
| Vercel Preview Comments | pass |
| Vercel Agent Review | skipping (no code review configured) |
| `e2e` (GitHub Action) | **pass** (33m 17s) |
| `Maestro E2E` (per-flow JUnit) | **pass** |
| Mergeability | `MERGEABLE` / `CLEAN` |

PR #32 is ready for you to squash-merge in the morning.

## Commits added to PR #32 overnight

- `26491b3` — `Merge remote-tracking branch 'origin/main' into jburich/neo-16-view-all-sportlots-sets`
- `9f491df` — `test(e2e): update cards-custom-subtree-gate for NEO-16 pluralized variantType labels`

The second commit fixed the single failure on the first CI cycle. Root cause was that NEO-22's new flow `cards-custom-subtree-gate.yaml` (introduced on main last week) was authored against pre-NEO-16 label text — it asserted on literal `"Variants"` for the column heading and `"Add custom Variants"` for the aria-label. NEO-16 made both of those derive from the selected variantType's `value` (pluralized). For the custom variantType the flow creates (`NEO22-CustomVT-${WORKER_INDEX || 0}`), the column heading is `NEO22-CustomVT-${WORKER_INDEX || 0}s` and the aria-label is `Add custom NEO22-CustomVT-${WORKER_INDEX || 0}s`. The fix only touched that one yaml file.

## Morning checklist

1. Skim PR #32 — three new commits since you last looked (the two NEO-16 commits + merge + Maestro fix). The merge auto-resolved; no manual conflicts. The Maestro fix is one yaml, 17 line diff.
2. `gh pr merge 32 -R neonbinder/neonbinder_convex --squash --delete-branch` to ship.
3. Remove the worktree: `cd /Users/jburich/workspace/neonbinder/neonbinder_web && git worktree remove ../neonbinder_web-neo16`.
4. Mark Linear [NEO-16](https://linear.app/neonbinder/issue/NEO-16) Done.

## What I did NOT do (per your instructions)

- Did not merge the PR.
- Did not rebase or force-push.
- Did not run any mutating `npx convex` commands.
- Did not touch other PRs or worktrees.


## Decision tree if the run is interrupted

If overnight session is interrupted and a fresh agent picks up:

1. **Check PR #32 status:** `gh pr checks 32 -R neonbinder/neonbinder_convex`
2. **If all green:** stop here. PR is ready for the user to squash-merge in the morning. Do NOT merge.
3. **If `e2e` or `Maestro E2E` failed:** read this log + the CI failure logs (Maestro Cloud upload URL is in the failure step output). Per memory `feedback_no_speculation_without_proof.md`, read logs before guessing. Then either fix-and-push, or document the failure here and stop.
4. **If a transient infra failure** (Vercel build flaked, Convex preview failed to deploy, runner crashed): re-run the failed check via `gh run rerun <run-id> --failed`. Do not just push an empty commit.

## Things that are explicitly NOT in scope tonight

- Merging the PR. User wants to do this themselves in the morning.
- Fixing pre-existing failures unrelated to NEO-16/NEO-22 — if they appear, document and leave.
- Force-pushing or rebasing. Per memory `feedback_never_cherry_pick_without_permission.md`.
- Mutating `npx convex` commands beyond `npx convex dev` (memory `feedback_no_direct_convex_commands.md`).

