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
   remote, else `neonbinder_web`). NeonBinder repos: `neonbinder_web` (remote
   `neonbinder_convex`), `neonbinder_browser`, `NeonBinderApp`, `neonbinder_terraform`.

2. **Confirm the PR exists** with a single read:
   `gh pr view <PR> --json state,title,url` from the repo dir. If it errors,
   report the error verbatim and stop (don't loop on a bad PR/repo).

3. **Load the Monitor schema** if not already loaded: `ToolSearch` →
   `select:Monitor`.

4. **Arm ONE persistent Monitor** running the engine:
   - `description`: `"PR #<PR> CI"` (it shows in every notification — keep it specific)
   - `persistent: true`
   - `command`: `bash <abs-path-to-this-skill-dir>/watch.sh <PR> <repo-dir>`
     (resolve the skill dir absolutely, e.g.
     `/Users/jburich/workspace/neonbinder/.claude/skills/pr-watch`).
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
   - `DONE GREEN …` → "✅ PR #N is green — all checks passed (watched Nm). Ready to merge."
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

## What the queue line means
When resolvable, `queue 24✓ 1✗ 4▶ 16⋯/45` is live flow-level progress from the
preview Convex `/e2e/status` endpoint (passed / failed / running / pending / total
flows). The engine auto-resolves the preview `.convex.site` URL (via the Vercel
bypass secret in `neonbinder_web/.env.local`) and the run id, but it still needs
`E2E_QUEUE_SECRET` — which is a **preview-only** default, NOT set on the dev
deployment, so `convex env get` returns empty locally. To light up the queue line,
export the secret on the Monitor command (`E2E_QUEUE_SECRET=… bash …/watch.sh …`).
If it's missing the engine prints `(queue progress unavailable …)` once and runs on
GitHub checks alone — the `e2e` gate check is the source of truth for green/red
regardless, so the watcher is fully correct without it (it's just finer progress).

## Hard rules
- **Read-only.** Only read-only `gh` reads + the read-only `/e2e/status` POST. Never
  comment, review, merge, edit, push, or run convex/npm mutations.
- **One watcher per PR.** Don't arm duplicate Monitors for the same PR. Use
  `TaskStop` to cancel a watch early (e.g. user merged it themselves).
- **No diagnosis by default.** On failure, report which check + (if asked or
  obviously useful) the failing log lines. The decision of what to do is the user's.
- **The queue secret is never printed.** The engine sends it as a header only.
