---
name: pr-queue
description: The production merge queue for the NeonBinder monorepo. One session runs the queue (`/pr-queue run`) and stays alive; any other session whose PR is approved to ship joins it (`/pr-queue join <pr>`) and merges only when the queue calls its turn. Merges go one at a time because a PR may merge only after it holds current main and the full CI suite has passed against that code. Use "run the PR queue" / "be the merge queue" for the queue side, and "queue PR 499 for merge" / "join the merge queue" / "ship this PR" for the requester side. Pushing a PR for testing never needs the queue; only merging to production does. The queue only calls the order; it never merges, pushes or triages.
argument-hint: run | join <pr> | status | leave <pr>
allowed-tools: Bash, ToolSearch, ListAgents, SendMessage, Monitor, TaskStop, ScheduleWakeup
---

# pr-queue: one PR merges to production at a time

## Why this exists

`main` only accepts a PR whose branch holds current `main` and whose full CI run
(E2E included) passed against exactly that code. When two sessions race to
merge, the first merge makes the second PR stale: its green run no longer
counts, and it needs main merged in and a whole new run (30-50 minutes).

So merging is serialised here, in a session, rather than in GitHub. Any session
may push any PR for testing at any time and get a full CI run. Only **merging
to production** waits for the queue.

## Roles

- **The queue session** (`run`). Holds the order, calls the next PR, notices
  when a turn finishes, and calls the next one at once without being asked. It
  never merges, pushes, reruns, triages reds or checks production. Those belong
  to the PR's own session.
- **A PR session** (`join`). Owns its PR end to end: main merge, push, CI,
  reds, the merge itself and the production check. It merges only during its
  turn.
- **Jason** decides anything the queue cannot: order changes beyond the
  defaults below, merge authorisation, a turn that is stuck.

## State and addresses

All state lives in one JSON file in the git common dir, shared by `main/` and
every worktree on this machine and never committed. Read and write it only
through `state.sh` beside this file, which locks every write:

```bash
Q="$(git rev-parse --show-toplevel)/.claude/skills/pr-queue/state.sh"
"$Q" show
```

Sessions address each other by the session name `ListAgents` prints (its first
line names this session: "This session is <name> [ref]"). The queue records
its own name as `owner`; a PR session records its name when it joins. The
queue works for local sessions on this machine only. A cloud thread cannot
receive replies, so it asks Jason to queue its PR from a local session.

## Messages

Every message starts with `PR-QUEUE` and a verb, so the first line (the only
part a person sees in the preview) says what it is. Reply to a message by
copying its `from` attribute as `to`.

| From → to | First line | Meaning |
|---|---|---|
| PR → queue | `PR-QUEUE JOIN #499 NEO-123 <title>` | Approved to ship; put me in line. |
| queue → PR | `PR-QUEUE QUEUED #499 position 2` | You are in line. Do not merge yet. |
| queue → PR | `PR-QUEUE YOUR TURN #499` | Go: the turn steps below. |
| PR → queue | `PR-QUEUE MERGED #499 <sha>` | Merge commit exists on main. |
| PR → queue | `PR-QUEUE OUT #499 <reason>` | Giving up the turn (red needing a fix, Jason's call, withdrawn). |
| PR → queue | `PR-QUEUE HOLD #499 <reason>` | Green and current, but the merge needs Jason. Keeps the turn for at most 10 minutes. |
| PR → queue | `PR-QUEUE RESUME #499` | Jason answered within the hold; the merge is going ahead. |
| queue → PR | `PR-QUEUE RELEASED #499` | The hold ran out; the turn passed on. Join again once Jason answers. |
| PR → queue | `PR-QUEUE LEAVE #499` | Take me out of the waiting line. |
| any → queue | `PR-QUEUE STATUS` | Reply with the line and the PR in flight. |

## `run`: be the queue

**Run the queue session on Haiku.** The work is mechanical: read a
`PR-QUEUE` line, run one `state.sh` command, send one message. The scripts
hold the ordering, locking and timers. Start the session with
`claude --model haiku`, or pick Haiku for this session only in the `/model`
picker. Do not rely on a `model:` field in this file: that override lasts
one turn, and the queue lives on later turns started by messages and the
heartbeat. If this session is on a bigger model, say so once and carry on.

1. **Claim the queue.** Read `"$Q" owner`. If it names a session that still
   appears in `ListAgents`, another queue is running: say so and stop. Two
   queues defeat the point. Otherwise `"$Q" set-owner <this session's name>`.
2. **Title the session** "PR queue" (with `cc-state title`, where installed).
3. **Resume what is on file.** `"$Q" show`. A queue that restarted keeps its
   line. If a PR is in flight, check it with `gh pr view <pr> --json state`:
   merged → record it (step 6); otherwise send its session a one-line
   `PR-QUEUE STATUS` asking where the turn stands. Any waiting PR whose
   session no longer appears in `ListAgents` stays in line; tell Jason.
4. **Arm the heartbeat.** Load Monitor (`ToolSearch select:Monitor`) and arm
   one Monitor, description `PR queue heartbeat`, command
   `bash <abs path>/tick.sh`, `timeout_ms` at the maximum (30 minutes). It
   checks once a minute and stays silent unless the in-flight PR merged or
   closed without a message, a `HOLD` passed 10 minutes, no CI run has
   started 20 minutes after a call, or PRs wait with nothing in flight.
   Cross-session messages wake the session too, so the heartbeat is the
   safety net, not the doorbell.
   **A Monitor expires after 30 minutes. Re-arm it on every expiry notice**,
   for as long as the queue runs; a queue without its heartbeat cannot enforce
   the hold cap. After a re-arm, a condition that is still true is reported
   again; act on it as if new.
5. **Report and yield.** One line: who is in flight, who is waiting. Then end the
   turn (`cc-state busy` where installed). The session stays open; messages and
   heartbeat lines arrive as new turns.
6. **On each message or heartbeat line:**
   - `JOIN`: `"$Q" join <pr> <ticket> <from> <title>`. Check the PR is open
     (`gh pr view <pr> --json state`). Reply `QUEUED` with the position. If
     nothing is in flight, call it straight away (below).
   - `MERGED`, or `TICK MERGED`: `"$Q" done <pr> merged <sha>`, then call the
     next PR at once. Do not wait for the production deploy: the next PR's CI
     may overlap the release. The merged
     PR's session still verifies production through `pr-close`.
   - `OUT` or `TICK CLOSED`: `"$Q" done <pr> out <reason>`, call the next.
     When the session fixes its PR it joins again and goes to the back.
   - `HOLD`: `"$Q" hold <pr> <reason>`. Keep the turn for now, since
     releasing it makes that green run stale on the next merge. Tell Jason in
     one line which PR waits on him, why, and that the turn passes on in 10
     minutes. Then end the turn (`cc-state answer` where installed).
   - `RESUME`: `"$Q" resume <pr>`; the turn carries on with no clock.
   - `TICK HOLD-EXPIRED <pr> <min>`: **the hold cap.** The queue is meant to
     keep merging overnight and through Jason's working day, so one PR waiting
     on him never stops the others. `"$Q" done <pr> out hold expired`, send
     its session `PR-QUEUE RELEASED #<pr>` with the hold reason, call the next
     PR, and leave Jason one line saying which PR was released and why. It
     joins again at the back once he answers.
   - `LEAVE`: `"$Q" done <pr> withdrawn`, reply with nothing further.
   - `STATUS`: reply with `"$Q" show` boiled down to one line per PR.
   - `TICK IDLE <pr> <min>`: ask the PR's session once where the turn
     stands. If that session no longer appears in `ListAgents`, skip it
     (`"$Q" done <pr> skipped session gone`), call the next, tell Jason.
   - `TICK WAITING`: a call was missed; call the next.
   - Jason asks to reorder: `"$Q" move <pr> <position>`. Quote his words in
     the reply to every session whose position changed.
7. **Calling the next PR.** `"$Q" call` prints the new in-flight entry, or
   `null` when the line is empty. Send its address:

   ```
   PR-QUEUE YOUR TURN #<pr>
   You are the only PR merging to production now. Follow the turn steps in the
   pr-queue skill: merge origin/main, push, watch CI, merge on green, then send
   PR-QUEUE MERGED #<pr> <sha>, or PR-QUEUE OUT / HOLD with the reason.
   ```

   If the send fails (the session is gone), `"$Q" done <pr> skipped session
   gone`, tell Jason, and call the next.
8. **Stopping.** Only when Jason says so: `"$Q" clear-owner`, stop the
   heartbeat with TaskStop, and tell each waiting session that no queue is
   running. The line stays on file for the next `run`.

## `join <pr>`: get a PR into production

Join only when the PR is **approved to ship**: audits done, and where the
change is UI, Jason has given his verdict on the preview. Joining is not
merge authorisation by itself; that still comes from Jason as `pr-close`
describes.

1. Read `"$Q" owner`. Empty, or not in `ListAgents`: no queue is running. Tell
   Jason ("PR #N is ready to merge; no PR queue is running") and do not merge.
2. Send `PR-QUEUE JOIN #<pr> <NEO-id> <short title>` to the owner. Keep the
   session title as `NEO-123(499) Description`, and mark the tab as waiting
   in line (`cc-state queue`, where installed). Switch it to `cc-state ci` on
   `YOUR TURN`, and `cc-state clear` on `LEAVE` or `RELEASED`.
3. Wait for `QUEUED` or `YOUR TURN`. Until your turn, keep working on the PR
   if you like and push for testing as often as you need: only the merge
   waits. If you push a fix that changes the PR's behaviour after joining,
   send `LEAVE` and join again once it is approved.
4. **On `YOUR TURN`:**
   1. `git fetch origin` and merge `origin/main` into the branch. If nothing
      came in and the latest run on this head is green (`gh pr view <pr>
      --json mergeStateStatus` says `CLEAN`), skip to step iv.
   2. Run the fast gates for the areas touched (the monorepo CLAUDE.md lists
      them) and push.
   3. Watch the run with `pr-watch`. A red with a known flake signature from
      the triage memory gets its one full rerun inside the turn. Any red that
      needs a code fix, or a second red: send `PR-QUEUE OUT #<pr> <reason>`
      and fix it out of turn, then join again.
   4. Green: confirm the branch still holds current main (`git fetch origin
      && git log --oneline HEAD..origin/main` prints nothing). It should,
      since nothing else merged during your turn; if something did, tell
      Jason, because the queue was bypassed.
   5. Merge with `pr-close`. The moment the merge commit exists, send
      `PR-QUEUE MERGED #<pr> <short sha>`, then carry on with `pr-close`'s
      production check, Linear and cleanup.
   6. If the merge needs Jason (his authorisation is missing or the permission
      check denies it), send `PR-QUEUE HOLD #<pr> <reason>` and ask Jason. Do
      not ask another session to merge for you. If he answers and the merge
      goes ahead within 10 minutes, send `PR-QUEUE RESUME #<pr>` first. On
      `PR-QUEUE RELEASED`, do not merge: the next PR is merging. Tell Jason,
      and once he answers, join again (the run is stale by then, so the next
      turn starts with a main merge and a new run).
5. `status`: send `PR-QUEUE STATUS` to the owner. `leave <pr>`: send
   `PR-QUEUE LEAVE #<pr>`.

## Hard rules

- **Merge to production only during your turn.** No exceptions for small
  PRs, docs-only PRs or "it's already green". A merge outside the queue makes
  the PR in flight stale and wastes its run.
- **The queue never merges, pushes or diagnoses.** It calls the order.
- **One queue at a time.** Check `owner` against `ListAgents` before
  claiming.
- **A HOLD lasts 10 minutes, then the turn passes on.** The queue runs
  unattended overnight and while Jason is at work; it never waits on him
  longer than that.
- **Never route around a permission denial** by asking another session to do
  the blocked step. It goes to Jason.
- **Testing pushes are free.** Never tell a session to stop pushing for
  tests; just keep its merge in line.
