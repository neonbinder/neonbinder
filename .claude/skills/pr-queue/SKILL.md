---
name: pr-queue
description: The production merge queue for the NeonBinder monorepo. One session runs the queue (`/pr-queue run`) and stays alive; any other session whose ticket is ready to ship joins it (`/pr-queue join <ticket>`) and pushes, opens its PR and merges only when the queue calls its turn. Spots in the line are Linear tickets, not PR numbers, because a session joins before its PR exists. Turns go one at a time because CI capacity is scarce and a PR may merge only after it holds current main and the full CI suite has passed against that code. Use "run the PR queue" / "be the merge queue" for the queue side, and "queue NEO-464 for merge" / "join the merge queue" / "ship this ticket" for the requester side. Until its turn a session works and tests locally and does not push. The queue only calls the order; it never merges, pushes or triages.
argument-hint: run | join <ticket> | status | leave <ticket>
allowed-tools: Bash, ToolSearch, ListAgents, SendMessage, Monitor, TaskStop, ScheduleWakeup
---

# pr-queue: one ticket ships to production at a time

## Why this exists

`main` only accepts a PR whose branch holds current `main` and whose full CI run
(E2E included) passed against exactly that code. When two sessions race to
merge, the first merge makes the second PR stale: its green run no longer
counts, and it needs main merged in and a whole new run (30-50 minutes).

CI capacity is the scarce thing. So a session runs its gates and its E2E specs
locally until they are green, then joins the queue. Its first push, its PR and
its merge all happen on its turn. Serialising this in a session rather than in
GitHub means a turn is one push, one full run and one merge.

## Roles

- **The queue session** (`run`). Holds the order, calls the next ticket,
  notices when a turn finishes, and calls the next one at once without being
  asked. It never merges, pushes, reruns, triages reds or checks production.
  Those belong to the ticket's own session.
- **A ticket session** (`join`). Owns its ticket end to end: main merge, push,
  the PR, CI, reds, the merge itself and the production check. It pushes and
  merges only during its turn.
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

Each spot in the line is a Linear ticket (`NEO-464`), because that is how Jason
tells sessions apart. An entry holds the ticket, the branch recorded at join,
the session's address, a title, the join time, and the PR number once the PR
exists (`set-pr`). `state.sh` refuses anything that is not shaped like a ticket.

Sessions address each other by the session name `ListAgents` prints (its first
line names this session: "This session is <name> [ref]"). The queue records
its own name as `owner`; a ticket session records its name when it joins. The
queue works for local sessions on this machine only. A cloud thread cannot
receive replies, so it asks Jason to queue its ticket from a local session.

## Messages

Every message starts with `PR-QUEUE`, a verb and the ticket, so the first line
(the only part a person sees in the preview) says what it is. Reply to a
message by copying its `from` attribute as `to`.

| From → to | First line | Meaning |
|---|---|---|
| ticket → queue | `PR-QUEUE JOIN NEO-464 <branch> <title>` | Ready to ship; put me in line. |
| queue → ticket | `PR-QUEUE QUEUED NEO-464 position 2` | You are in line. Do not push or merge yet. |
| queue → ticket | `PR-QUEUE YOUR TURN NEO-464` | Go: the turn steps below. |
| ticket → queue | `PR-QUEUE PR NEO-464 #499` | My PR exists; here is its number. |
| ticket → queue | `PR-QUEUE MERGED NEO-464 <sha>` | Merge commit exists on main. |
| ticket → queue | `PR-QUEUE OUT NEO-464 <reason>` | Giving up the turn (red needing a fix, Jason's call, withdrawn). |
| ticket → queue | `PR-QUEUE HOLD NEO-464 <reason>` | Green and current, but the merge needs Jason. Keeps the turn for at most 10 minutes. |
| ticket → queue | `PR-QUEUE RESUME NEO-464` | Jason answered within the hold; the merge is going ahead. |
| queue → ticket | `PR-QUEUE RELEASED NEO-464` | The hold ran out; the turn passed on. Join again once Jason answers. |
| ticket → queue | `PR-QUEUE LEAVE NEO-464` | Take me out of the waiting line. |
| any → queue | `PR-QUEUE STATUS` | Reply with the line and the ticket in flight. |

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
   line. If a ticket is in flight and has a `pr`, check it with
   `gh pr view <pr> --json state`: merged → record it (step 6). Otherwise send
   its session a one-line `PR-QUEUE STATUS` asking where the turn stands. Any
   waiting ticket whose session no longer appears in `ListAgents` stays in
   line; tell Jason. An old entry with a PR number and no ticket is cleared
   with `"$Q" done <pr number> <outcome>`.
4. **Arm the heartbeat.** Load Monitor (`ToolSearch select:Monitor`) and arm
   one Monitor, description `PR queue heartbeat`, command
   `bash <abs path>/tick.sh`, `timeout_ms` at the maximum (30 minutes). It
   checks once a minute and stays silent unless the in-flight PR merged or
   closed without a message, a `HOLD` passed 10 minutes, no CI run has
   started on the ticket's branch 20 minutes after a call, or tickets wait
   with nothing in flight. It follows the PR by its recorded number, or finds
   it from the branch when none is recorded yet.
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
   - `JOIN`: `"$Q" join <ticket> <branch> <from> <title>`. No PR is needed and
     nothing is checked on GitHub; just record it. Reply `QUEUED` with the
     position. If nothing is in flight, call it straight away (below).
   - `PR`: `"$Q" set-pr <ticket> <pr>`. No reply needed.
   - `MERGED`, or `TICK MERGED`: `"$Q" done <ticket> merged <sha>`, then call
     the next ticket at once. Do not wait for the production deploy: the next
     ticket's CI may overlap the release. The merged ticket's session still
     verifies production through `pr-close`.
   - `OUT` or `TICK CLOSED`: `"$Q" done <ticket> out <reason>`, call the next.
     When the session fixes its work it joins again and goes to the back.
   - `HOLD`: `"$Q" hold <ticket> <reason>`. Keep the turn for now, since
     releasing it makes that green run stale on the next merge. Tell Jason in
     one line which ticket waits on him, why, and that the turn passes on in 10
     minutes. Then end the turn (`cc-state answer` where installed).
   - `RESUME`: `"$Q" resume <ticket>`; the turn carries on with no clock.
   - `TICK HOLD-EXPIRED <ticket> <min>`: **the hold cap.** The queue is meant
     to keep merging overnight and through Jason's working day, so one ticket
     waiting on him never stops the others. `"$Q" done <ticket> out hold
     expired`, send its session `PR-QUEUE RELEASED <ticket>` with the hold
     reason, call the next ticket, and leave Jason one line saying which
     ticket was released and why. It joins again at the back once he answers.
   - `LEAVE`: `"$Q" done <ticket> withdrawn`, reply with nothing further.
   - `STATUS`: reply with `"$Q" show` boiled down to one line per ticket.
   - `TICK IDLE <ticket> <min>`: ask the ticket's session once where the turn
     stands. If that session no longer appears in `ListAgents`, skip it
     (`"$Q" done <ticket> skipped session gone`), call the next, tell Jason.
   - `TICK WAITING`: a call was missed; call the next.
   - Jason asks to reorder: `"$Q" move <ticket> <position>`. Quote his words
     in the reply to every session whose position changed.
7. **Calling the next ticket.** `"$Q" call` prints the new in-flight entry, or
   `null` when the line is empty. Send its address:

   ```
   PR-QUEUE YOUR TURN <ticket>
   You are the only ticket shipping to production now. Follow the turn steps in
   the pr-queue skill: merge origin/main, push, open the PR if there is none and
   send PR-QUEUE PR <ticket> #<n>, watch CI, merge on green, then send
   PR-QUEUE MERGED <ticket> <sha>, or PR-QUEUE OUT / HOLD with the reason.
   ```

   If the send fails (the session is gone), `"$Q" done <ticket> skipped
   session gone`, tell Jason, and call the next.
8. **Stopping.** Only when Jason says so: `"$Q" clear-owner`, stop the
   heartbeat with TaskStop, and tell each waiting session that no queue is
   running. The line stays on file for the next `run`.

## `join <ticket>`: get a ticket into production

Join when the work is **ready to ship**: the fast gates and the E2E specs
covering the change are green locally, and the audits are done. Where the
change is UI, Jason has given his verdict. With no PR yet there is no
preview, so that verdict usually comes from local testing (a local Vite URL
and screenshots). Joining is not merge authorisation by itself; that still
comes from Jason as `pr-close` describes.

1. Read `"$Q" owner`. Empty, or not in `ListAgents`: no queue is running. Tell
   Jason ("NEO-123 is ready to ship; no PR queue is running") and do not push
   or merge.
2. Send `PR-QUEUE JOIN <ticket> <branch> <short title>` to the owner, with
   the ticket as `NEO-123` and the branch as `git branch --show-current`
   prints it. Mark the tab as waiting in line (`cc-state queue`, where
   installed). Switch it to `cc-state ci` on `YOUR TURN`, and `cc-state clear`
   on `LEAVE` or `RELEASED`.
3. **Already have an open PR?** Join the same way, then send
   `PR-QUEUE PR <ticket> #<pr>` as soon as `QUEUED` (or `YOUR TURN`) arrives,
   so the queue can follow it.
4. Wait for `QUEUED` or `YOUR TURN`. Until your turn, keep working and testing
   locally, but **do not push**: a push starts the full CI run the queue is
   rationing. The one exception is a push Jason asks for (for example to get a
   preview to look at). If you change the work's behaviour after joining, send
   `LEAVE` and join again once it is ready.
5. **On `YOUR TURN`:**
   1. `git fetch origin` and merge `origin/main` into the branch. If a PR
      already exists, nothing came in, nothing is unpushed and the latest run
      on this head is green (`gh pr view <pr> --json mergeStateStatus` says
      `CLEAN`), skip to step v.
   2. Run the fast gates for the areas touched (the monorepo CLAUDE.md lists
      them) and push.
   3. **No PR yet: create it now** with `gh pr create`. The title is
      `NEO-123(<PR#>) Description`, and the number does not exist until the PR
      does, so create it as `NEO-123 Description` and then
      `gh pr edit <n> --title "NEO-123(<n>) Description"`. Send
      `PR-QUEUE PR <ticket> #<n>` straight away. Retitle the session the same
      way.
   4. Watch the run with `pr-watch`. A red with a known flake signature from
      the triage memory gets its one full rerun inside the turn. Any red that
      needs a code fix, or a second red: send `PR-QUEUE OUT <ticket> <reason>`
      and fix it out of turn (locally, without pushing), then join again.
   5. Green: confirm the branch still holds current main (`git fetch origin
      && git log --oneline HEAD..origin/main` prints nothing). It should,
      since nothing else merged during your turn; if something did, tell
      Jason, because the queue was bypassed.
   6. Merge with `pr-close`. The moment the merge commit exists, send
      `PR-QUEUE MERGED <ticket> <short sha>`, then carry on with `pr-close`'s
      production check, Linear and cleanup.
   7. If the merge needs Jason (his authorisation is missing or the permission
      check denies it), send `PR-QUEUE HOLD <ticket> <reason>` and ask Jason.
      Do not ask another session to merge for you. If he answers and the merge
      goes ahead within 10 minutes, send `PR-QUEUE RESUME <ticket>` first. On
      `PR-QUEUE RELEASED`, do not merge: the next ticket is merging. Tell
      Jason, and once he answers, join again (the run is stale by then, so the
      next turn starts with a main merge and a new run).
6. `status`: send `PR-QUEUE STATUS` to the owner. `leave <ticket>`: send
   `PR-QUEUE LEAVE <ticket>`.

## Hard rules

- **Merge to production only during your turn.** No exceptions for small
  PRs, docs-only PRs or "it's already green". A merge outside the queue makes
  the PR in flight stale and wastes its run.
- **Push only during your turn**, unless Jason asks for a push. A push starts
  a full CI run, and CI capacity is what the queue rations. Test locally
  until then.
- **The queue never merges, pushes or diagnoses.** It calls the order.
- **One queue at a time.** Check `owner` against `ListAgents` before
  claiming.
- **A HOLD lasts 10 minutes, then the turn passes on.** The queue runs
  unattended overnight and while Jason is at work; it never waits on him
  longer than that.
- **Never route around a permission denial** by asking another session to do
  the blocked step. It goes to Jason.
