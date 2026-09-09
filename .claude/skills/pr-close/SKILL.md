---
name: pr-close
description: Close out a PR in the NeonBinder monorepo end-to-end — merge it, verify the change actually reached production (not just that CI is green or the merge succeeded), smoke-test neonbinder.io view-only, close the linked Linear ticket(s), then reclaim the worktree and branches. Use when a PR is approved/green and ready to ship (e.g. "close out PR 73", "merge and ship PR 80", "wrap up this PR"). Requires explicit confirmation before merging; never fabricates a Linear ticket number; never proceeds past a failed production deploy; never deletes anything holding unsaved work.
argument-hint: <pr-number> [linear-ticket-id ...] [--repo <dir>] [--no-cleanup]
allowed-tools: Bash, ToolSearch, AskUserQuestion, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__computer, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__read_console_messages, mcp__claude_ai_Vercel__list_deployments, mcp__claude_ai_Vercel__get_deployment, mcp__claude_ai_Vercel__get_deployment_build_logs, mcp__linear-server__get_issue, mcp__linear-server__list_issue_statuses, mcp__linear-server__save_issue, mcp__linear-server__list_issues
---

# pr-close — merge, verify prod, smoke-test, close the ticket, reclaim the worktree

Five gates, run in strict order, each one a hard stop if it doesn't pass:
**merge → verify the production deploy actually succeeded → smoke-test view-only →
close the Linear ticket(s) → clean up the worktree and branches.** This skill exists
because "PR merged" and "CI green" are **not** proof the change reached production —
see "Why gate 2 exists" below. Do not skip or reorder gates, and do not let a later
gate run if an earlier one failed.

## Repo & environment (resolved once, 2026-07-25 — re-verify if anything 404s)
- **Repo dir** (default, override with `--repo`): the monorepo checkout — from inside
  any checkout or worktree, `git rev-parse --show-toplevel`; in the standard layout
  that is `<workspace>/main`. The workspace wrapper dir above it holds no app code. Deploy-relevant code
  is under `apps/web`. GitHub repo: `neonbinder/neonbinder`.
- **Vercel — the correct project** (production deploys build here): team **NeonBinder**
  (slug `neon-binder`), project `neonbinder` (framework vite), prod aliases
  `neonbinder.io` and `www.neonbinder.io`. Resolve ids at run time with the Vercel MCP
  (`list_teams`, `list_projects`) or `vercel teams ls` / `vercel project ls`; never a
  personal team. If a deployment lookup resolves into any other team you have the
  wrong one — stop and re-resolve. (Identifier history lives in the private
  operational notes, not here.)
- **Linear**: single team "Neonbinder", tickets are `NEO-###`.

## Steps

### 1. Resolve inputs
- PR number (required, first arg).
- `--repo <dir>` overrides the repo dir.
- Any `NEO-###` args are ticket overrides; otherwise derive them in step 6.
- `--no-cleanup` skips gate 5 (step 7) — use only if the user asks to keep the worktree.
- `cd` into the repo dir for all `gh`/`git` calls below.

### 2. Pre-flight — confirm the PR is actually ready
`gh pr view <PR> --json state,mergeStateStatus,statusCheckRollup,title,headRefName,url,mergeable`
- Not `OPEN` → stop, report the actual state (don't act on an already-merged/closed PR).
- Any check not green → stop. Tell the user to fix it or run `/pr-watch <PR>` first;
  do not merge a red PR.
- `mergeable != MERGEABLE` → stop, report the conflict.

### 3. Merge authorization — who asked for this run decides
**If the user explicitly invoked this skill on this PR** ("close out PR 112",
"/pr-close 112", "merge and ship PR 80"), that IS the authorization. Merge directly —
do not ask again. Re-confirming something the user just asked for is noise, not safety.

**If YOU chose to run this skill** — the user didn't name it, and you decided a green
PR should be closed out — then you must confirm before merging: show PR number, title,
and URL via `AskUserQuestion` ("merge PR #N: '<title>' now?"). The confirmation exists
to catch an assistant-initiated merge the user never asked for, which is the actual
failure mode from repo history. It is not a ritual to perform on a merge they just
requested.

Either way: `gh pr merge <PR> --squash --delete-branch` (always squash-merge —
matches this repo's convention; there is no GitFlow exception here, that only applies
to the separate `terraform` repo).

Capture the merge commit SHA immediately after:
`gh pr view <PR> --json mergeCommit --jq .mergeCommit.oid` (retry once after a couple
seconds if empty — the API can lag right after merge).

### 4. Gate 2 — verify the production deploy actually succeeded

**Why this gate exists:** on 2026-07-25, PR #73 merged clean with all GitHub checks
green, but the Vercel production build's `npx convex deploy` step failed on a stale
schema field in a live document — the merge and CI were both green while prod stayed
on the *previous* release for hours, undetected, until someone happened to check the
Vercel dashboard. A green merge only proves the code compiles and passes tests; it
says nothing about whether the actual Convex schema push against live data succeeds.
This gate is what would have caught that immediately instead of hours later.

Procedure:
1. Load Vercel tools if deferred: `ToolSearch` → `select:mcp__claude_ai_Vercel__list_deployments,mcp__claude_ai_Vercel__get_deployment,mcp__claude_ai_Vercel__get_deployment_build_logs`.
2. Poll `list_deployments` (projectId/teamId above) every ~30s (`Bash` with
   `run_in_background: true` running `sleep 30` as the wait timer — never a bare
   foreground `sleep`) until a deployment appears whose `meta.githubCommitSha` matches
   the merge commit SHA and `target: "production"`.
3. Once found, poll that deployment's `readyState` the same way until it's terminal
   (`READY` or `ERROR`/`CANCELED`). Typical build time is 1-3 minutes; cap the wait at
   15 minutes before reporting a timeout.
4. **`ERROR` → STOP HERE.** Pull `get_deployment_build_logs` with `errorsOnly: true`,
   report the failure verbatim to the user, and do **not** proceed to the smoke test or
   ticket closure. The whole point of this gate is that a failed prod deploy must block
   the rest of the close-out, exactly like it should have on 2026-07-25.
5. `READY` → proceed to step 5.

### 5. Smoke test — view-only, no exceptions
1. Load Chrome tools if deferred: `ToolSearch` →
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__read_console_messages`.
2. Open a new tab, navigate to `https://neonbinder.io`.
3. Check auth state. If the Clerk session is cached and you land in the app, proceed.
   If redirected to sign-in, **stop and ask the user to log in manually** in that tab —
   never attempt to automate their personal login. Wait for their confirmation, then
   continue.
4. Navigate to whatever page is most relevant to the merged PR (best-effort from the
   PR title/description) and confirm it renders the expected change. Use
   `read_console_messages` to check for errors and `read_page`/a screenshot as evidence.
5. **Hard constraint: view-only.** Only navigate and read. Never click a save/submit/
   delete/sync button or otherwise mutate data during this check.
6. Show the user the evidence (screenshot + any console errors found) and get their
   explicit confirmation it looks right before moving to step 6 — this is a visual/UX
   judgment call, not one to self-certify.

### 6. Close the Linear ticket(s)
Only run this step if gate 2 was `READY` **and** the user confirmed the smoke test.

1. Determine ticket ID(s): use any passed as args; otherwise parse `NEO-\d+` patterns
   from the PR title/branch. PR titles sometimes use a range shorthand like
   `NEO-71-74` meaning four tickets (`NEO-71`..`NEO-74`) — expand ranges, dedupe.
   **Never invent a ticket number.** If none can be found, ask the user which ticket(s)
   to close.
2. For each ticket: `get_issue` to confirm it exists and check its current state, then
   `list_issue_statuses` (team "Neonbinder") to find the done/closed state id, then
   `save_issue` to set it. Report the new state and a link for each.

### 7. Gate 5 — reclaim the worktree and branches

**Why this gate exists:** without it, worktrees and dead branches pile up silently.
On 2026-07-29 the repo had accumulated a dead worktree plus four stale local branches
from PRs merged days earlier, and two closed-PR remote branches — none of it caught
until the user asked. Cleanup is part of closing a PR, not a separate chore.

Run this only after gate 2 was `READY`. It is safe to run even if step 6 was skipped
(e.g. a deps PR with no ticket) — a shipped PR's worktree is reclaimable regardless.

**The squash-merge trap:** this repo always squash-merges, so the branch's original
commits never appear in `main`'s history. `git log origin/main..<branch>` will list
commits that *are* in fact shipped. **Never use commit reachability to decide whether
a branch is safe to delete — compare file contents:**

```bash
files=$(git diff --name-only main...<branch>)
for f in $files; do git diff --quiet main <branch> -- "$f" || echo "DIFFERS: $f"; done
```
No `DIFFERS` lines → the branch is fully represented in `main` and safe to delete.
Any `DIFFERS` line → **do not delete**; report the file(s) and let the user decide.

Procedure:
1. **Worktree.** `git worktree list` — find the one holding the PR's head branch.
   - `git -C <worktree> status --short` first. **Non-empty → do not remove it.** Report
     the uncommitted files and stop the cleanup gate there; everything else already
     succeeded.
   - Clean → verify contents against `main` per the check above, then
     `git worktree remove <path>` and `git worktree prune`.
2. **Local branch.** Note that `gh pr merge --delete-branch` in step 3 **fails to delete
   the local branch when a worktree still holds it** (`cannot delete branch '<b>' used by
   worktree at ...`) — that error is easy to miss because the merge itself still succeeds.
   Remove the worktree first, then `git branch -D <branch>`.
3. **Sweep other stale locals.** `git fetch origin --prune`, then
   `git branch -vv | grep '\[.*: gone\]'` — for each, run the content check above and
   delete only the ones fully represented in `main`. List what you deleted.
4. **Remote branches.** `git branch -r` — for each non-`main` remote branch, check
   `gh pr list --state all --head <branch>`. Delete only branches whose PR is `MERGED`
   or `CLOSED` **and** which pass the content check, and **ask before deleting any
   remote ref** — it's a remote mutation, not local hygiene.
   **Never delete `origin/chore/flow-timings-refresh`** — `.github/workflows/refresh-flow-timings.yml`
   force-pushes to it on a schedule; deleting it breaks that workflow. Before deleting
   any remote branch, grep `.github/` for its name to catch other such cases.
5. **Stashes.** `git stash list` — stashes are repo-global, so they outlive the branch
   they were made on and get orphaned. Report any that reference a branch that no longer
   exists, with `git stash show --stat`. **Never drop a stash without asking**, and if the
   user says drop it, print `git stash show -p` first and record the dropped blob SHA in
   your report so it can be recovered via `git stash apply <sha>`.
6. **Orphaned E2E browsers.** Any PR whose worktree ran E2E leaves detached Chrome
   instances behind — Maestro sets chromedriver's `detach` option, so a flow that timed
   out or a harness that was Ctrl-C'd leaves a ~280MB headless browser running forever.
   On 2026-08-10 eleven of them had accumulated on this machine, several hours old.
   Run the repo's sweeper from the monorepo checkout (not the removed worktree):

   ```bash
   cd "$(git rev-parse --show-toplevel)/apps/web" && ./lib-e2e-chrome.sh
   ```

   (Added in NEO-138. If the checkout predates it and the script isn't there, skip this
   step rather than improvising — see the warning below.)

   It matches on the process *executable* — `chromedriver`, `Google Chrome for Testing`,
   and branded Chrome only when its args show a chromedriver temp profile or
   `--test-type=webdriver`. A real browsing session matches none of those, so this
   never touches the user's own browser and needs no confirmation. Report the count it
   killed (it prints one line either way).

   **Do not hand-roll this with `pkill -f`/`grep` over full command lines.** Anything
   whose *arguments* mention the Chrome path — the E2E runner itself, which exports
   `SE_BROWSER_PATH`, or your own shell — gets swept up and killed. That is exactly how
   the first version of the sweeper killed its calling shell.

### 8. Final report
One consolidated summary: merge commit, prod deployment id/URL that went `READY`,
smoke-test evidence, which ticket(s) got closed (or why step 6 was skipped), and what
gate 5 reclaimed — worktree, branches, orphaned browsers — plus anything it
deliberately left alone and why.

## Hard rules
- **Never merge a PR the user did not ask you to merge.** If they invoked this skill on
  the PR, that is the authorization — merge without re-asking. If you initiated the
  close-out yourself, the step-3 confirmation is mandatory.
- **Never treat "merged" or "CI green" as proof of a successful production deploy.**
  Gate 2 (an actual Vercel `READY` state on the merge commit) is mandatory and blocking.
- **Never proceed past a gate-2 `ERROR`.** Stop, report, and let the user decide next
  steps — do not attempt to fix the prod issue as part of this skill.
- **Browser smoke test is view-only.** No clicks that mutate data, no automated login.
- **Never fabricate a Linear ticket number.** Parse it or ask.
- **Never close a Linear ticket if gate 2 failed or the smoke test wasn't confirmed.**
- **Never judge a branch's safety by commit reachability.** Squash-merge means shipped
  commits are absent from `main`'s history. Compare file contents (step 7) or you will
  either refuse to clean up shipped work or, worse, mistake unshipped work for shipped.
- **Never remove a worktree with uncommitted changes, never drop a stash, and never
  delete a remote ref without asking.** Report and let the user decide.
