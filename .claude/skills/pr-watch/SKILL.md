---
name: pr-watch
description: Watch a GitHub PR's CI until it is fully green or any check fails, surfacing a progress update roughly every 2 minutes and a clear terminal verdict. Read-only — it never comments, merges, pushes, or edits. Use whenever a PR has been pushed and you want hands-off monitoring (e.g. "watch PR 53", "babysit this PR", "tell me when CI finishes / goes green / fails"). Replaces the old pr-watcher agent.
argument-hint: <pr-number> [--repo <dir>]
allowed-tools: Bash, Monitor, ToolSearch, TaskStop
---

# pr-watch — background PR CI watcher

Watch one GitHub PR's checks from the **main agent loop** (not a subagent) so the
watch survives and progress is surfaced live. The heavy lifting is in the
committed engine `watch.sh` next to this file; your job is to arm it via a
**Monitor** and relay what comes back.

## Why a Monitor armed from the main loop (read this)
The old `pr-watcher` *agent* armed a Monitor too, but a subagent can't receive
Monitor notifications after it returns control — so the watch died on launch and
you only ever got one (premature) "final" message. Arming the Monitor **here, in
the main loop**, fixes that: each line the script prints becomes a notification
**to you**, so you get the ~2-minute progress updates AND the terminal line
reliably. Do **not** delegate this to a subagent.

## Steps

1. **Parse args.** First token = PR number (required). `--repo <dir>` overrides
   the repo directory (default: current dir if it's a git repo with a GitHub
   remote, else `apps/web`). NeonBinder repos: `apps/web` (remote
   `neonbinder_convex`), `services/browser`, and the separate `terraform` checkout (`neonbinder_ioc`).

2. **Confirm the PR exists** with a single read:
   `gh pr view <PR> --json state,title,url` from the repo dir. If it errors,
   report the error verbatim and stop (don't loop on a bad PR/repo).

3. **Load the Monitor schema** if not already loaded: `ToolSearch` →
   `select:Monitor`.

4. **If a watcher is already running for this PR, `TaskStop` it first.** The
   case that actually bites is re-arming after you push a new commit: the old
   Monitor is still ticking on the previous SHA, so you get two interleaved
   streams and no way to tell which verdict belongs to which commit. Check
   `TaskList` for a running `PR #<PR> CI` before arming. (This rule already
   existed under Hard rules and was still broken on 2026-08-02 — the trigger,
   not the principle, is the part worth remembering.)

   Then **arm ONE persistent Monitor** running the engine:
   - `description`: `"PR #<PR> CI"` (it shows in every notification — keep it specific)
   - `persistent: true`
   - `command`: `bash <abs-path-to-this-skill-dir>/watch.sh <PR> <repo-dir>`
     (resolve the skill dir absolutely, e.g.
     `$(git rev-parse --show-toplevel)/.claude/skills/pr-watch`).
   The script prints one status line per tick (every ~120s) and a single `DONE …`
   line at the terminal state, then exits — which ends the Monitor.

5. **Tell the user you're watching** in one line (PR #, title, that you'll post
   ~2-min updates and ping them the moment it goes green or a check fails), then
   **yield** so they can keep working. Updates arrive as notifications.

6. **On each notification line**, relay a tight one-liner. The script's line is
   already concise (`[t+4m] RUNNING — checks 6/15 done, 0 failed · seed ✓ ·
   runners 3/8 · e2e ▶ · maestro ▶ · queue 24✓ 1✗ 4▶ 16⋯/45`) — pass it through;
   don't pad it.

7. **On the `DONE …` line** (terminal), give the final verdict clearly:
   - `DONE GREEN …` → **verify before you say it.** Run `gh pr checks <PR>` and
     confirm zero `pending` and zero `fail`, then report "✅ PR #N is green —
     all checks passed (watched Nm). Ready to merge." One read, every time.
     Non-negotiable when the `DONE` arrives within ~2 minutes of a push, which
     is the shape of the historical false positive (see "Why GREEN waits on the
     gate check"). If the verify disagrees with the verdict, trust the verify,
     say so plainly, and re-arm.
   - `DONE FAILED …` → "❌ PR #N: \<failing check(s)\> failed (watched Nm)." Then,
     and only then, you MAY pull failing detail with the read-only
     `gh run view <run-id> --log-failed` to quote the failing lines. Do not
     diagnose or propose fixes unless the user asks.
   - `DONE MERGED|CLOSED` → state it. `DONE TIMEOUT` → "still running after the
     safety window; re-invoke to keep watching."
   This terminal report is the most important output — make it unmissable.

## Tuning (optional env on the Monitor command)
- `PR_WATCH_INTERVAL=120` — seconds between ticks (default 120; the ~2-min cadence).
- `PR_WATCH_MAX_MIN=90` — safety stop.
- `PR_WATCH_NO_QUEUE=1` — skip the Convex flow-progress enrichment (GitHub only).
- `PR_WATCH_REQUIRED_CHECK="CI Gate"` — the gate check that must be green before
  a `DONE GREEN` is emitted. Change it only if the pipeline's final gate job is
  renamed.

## Why GREEN waits on the gate check
**"No pending checks" is not a terminal state.** Right after a push, GitHub has
attached only the fast third-party checks — Vercel answers within seconds —
while the PR Pipeline run is still queued and has registered nothing. A naive
`total > 0 && pending == 0` reads that as all-green and exits, so every push
produces a confident, wrong "PR is mergeable" about 30 seconds later. That bug
was live and fired four times in one session (PRs #117 and #119) before it was
caught; each time it was only noticed because the verdict was re-checked by hand.

So `GREEN` additionally requires `$PR_WATCH_REQUIRED_CHECK` (default `CI Gate`)
to have concluded. That job depends on every other job in the pipeline, so it
cannot be green early, and it is absent entirely until the run registers — which
is exactly what separates "finished" from "not started". `SKIPPED`/`NEUTRAL`
count as satisfied so a PR whose pipeline legitimately skips does not hang until
the safety timeout. While waiting, the tick line says
`waiting for CI Gate (pipeline not registered yet)`.

**Corollary for the agent:** a `DONE GREEN` that arrives within a minute of a
push is still worth one `gh pr checks <PR>` before acting on it.

## What the queue line means
When resolvable, `queue 24✓ 1✗ 4▶ 16⋯/45` is live flow-level progress from the
preview Convex `/e2e/status` endpoint (passed / failed / running / pending / total
flows). The engine auto-resolves the preview `.convex.site` URL (via the Vercel
bypass secret in `apps/web/.env.local`) and the run id, but it still needs
`E2E_QUEUE_SECRET` — which is a **preview-only** default, NOT set on the dev
deployment, so `convex env get` returns empty locally. To light up the queue line,
export the secret on the Monitor command (`E2E_QUEUE_SECRET=… bash …/watch.sh …`).
If it's missing the engine prints `(queue progress unavailable …)` once and runs on
GitHub checks alone — the `e2e` gate check is the source of truth for green/red
regardless, so the watcher is fully correct without it (it's just finer progress).

## Hard rules
- **Read-only.** Only read-only `gh` reads + the read-only `/e2e/status` POST. Never
  comment, review, merge, edit, push, or run convex/npm mutations.
- **Never act on a terminal verdict without re-checking it.** A `DONE GREEN` is
  a prompt to run `gh pr checks <PR>`, not a fact to merge on. This engine has
  produced confident false greens before; the guard added since makes that far
  less likely but does not make the verdict authoritative. Merging, reporting
  "ready to merge", or closing anything out all require the fresh read first.
- **One watcher per PR.** Don't arm duplicate Monitors for the same PR — and the
  moment that actually happens is re-arming after a push while the previous
  watcher is still live. `TaskStop` the old one first. Also use `TaskStop` to
  cancel a watch early (e.g. the user merged it themselves).
- **No diagnosis by default.** On failure, report which check + (if asked or
  obviously useful) the failing log lines. The decision of what to do is the user's.
- **The queue secret is never printed.** The engine sends it as a header only.

## If the pipeline never registers (learned 2026-09-04, PR #221)
A tick line that stays on `waiting for CI Gate (pipeline not registered yet)`
for more than ~4 minutes after a push is almost never queueing. **GitHub
creates no `pull_request` workflow run for a PR whose merge ref cannot be
built** — i.e. the PR is `CONFLICTING` against its base — and it stays silent
about it. Closing/reopening the PR and pushing an empty commit both do
nothing in that state. Check first:
`gh pr view <PR> --json mergeable,mergeStateStatus` → `CONFLICTING` means
merge (or rebase onto) `origin/main` in the worktree, resolve, run the fast
gates, push; the run appears within a minute of the push that makes the PR
mergeable again. Only if the PR is `MERGEABLE` and still has no
`github-actions` check suite on the head SHA
(`gh api repos/<o>/<r>/commits/<sha>/check-suites`) is it a genuinely
dropped event, and an empty commit is the right remedy.
