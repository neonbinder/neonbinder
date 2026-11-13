---
name: patterns-coded-convex-error-oracle
description: Turning a plain Error into a coded ConvexError un-redacts it in prod; the ownership check must precede it and a test must pin a NON-OWNER against a job in the coded state (NEO-529)
metadata:
  type: feedback
---

A plain `throw new Error(...)` reaches a prod client as "Server Error"; a
`ConvexError`'s `data` reaches it verbatim, also out of `ctx.runMutation` into a
public action. So converting a refusal to a coded ConvexError (NEO-529
BATCH_NOT_COLLECTING carries the job `status`) turns any check-ordering slip
into a prod existence/state oracle that used to be dev-only.

**Why:** existing "refuses a job the caller does not own" tests usually seed the
victim's job in its happy state (e.g. `collecting`). A regression that moved the
status check above `findOwnedJob` still answers "Job not found" for that seed,
so the suite stays green while a non-owner learns another user's closed job's
status in prod.

**How to apply:** on any diff that introduces or extends a coded ConvexError,
(1) confirm the owner-scoped lookup throws a plain, uniform not-found BEFORE the
coded throw; (2) confirm `data` holds only server enums/codes, never ids, user
ids or names; (3) require a test where a non-owner hits a job in the coded
state and gets no code. See [[patterns-convex-auth-boundary]].
