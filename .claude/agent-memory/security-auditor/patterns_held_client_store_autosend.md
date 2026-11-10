---
name: patterns-held-client-store-autosend
description: Client hold-then-auto-send flows - a readiness check weaker than the server's refusal plus a failure key over unrelated fields burns the shared job-start budget and re-fires paid work; module stores keyed by user still need a purge on identity change
metadata:
  type: project
---

An auto-sending client (nothing is pressed; an effect fires when "ready") turns
every server refusal the client did not predict into a repeatable side effect.

**Why:** NEO-452 audit. `ready` did not know a variant has no cards, the server
did, and the job row is written before the refusal. The "don't retry" key covered
all defaults, so editing an unrelated field re-fired the whole send.

**How to apply:**
- Compare the client's readiness with every refusal in the server path. Each gap
  is a loop candidate. Ask what each attempt costs BEFORE the refusal.
- Job starts count by `createdAt`, so closing a job does not refund the budget,
  and the budget is shared with every other intake door.
- The retry key must hold only fields that can change the server's answer.
- A path that does paid work first (zip upload then run) needs a cancel on refusal.
- A module-level store keyed by user isolates reads, but nothing purges it: check
  sign-out, and any global side effect (beforeunload) reads all keys.
- Identity lag: the mount key follows Clerk at once, the Convex token follows an
  effect later. Check what holds an auto-send in that gap (a fresh query answer).
