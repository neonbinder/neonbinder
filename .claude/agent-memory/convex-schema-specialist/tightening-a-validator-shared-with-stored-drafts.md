---
name: tightening-a-validator-shared-with-stored-drafts
description: optional→required tightening checklist beyond the schema — a validator reused for args AND for returning stored rows can only tighten in the handler; a new required arg makes auth-guard tests pass vacuously; the E2E reset runs after deploy
metadata:
  type: feedback
---

When a field goes optional → required, the schema line is the easy part.
Three traps found on NEO-331 (`leagues.level`, 2026-10-10):

1. **A validator shared between `args` and a `returns` over stored rows
   cannot be tightened.** `entityReviewQueue.leagueCreateValidator` feeds
   both `recordDecision`'s args and `decisionValidator`, which `getBatch`
   returns from stored queue rows. Tightening it breaks every read of a
   legacy draft. Enforce the new rule inside the mutation handler instead,
   and leave the shared validator (and the schema copy of the draft) optional.
2. **A new required arg turns auth-guard tests vacuous.** Convex validates
   args before the handler, so `publicFunctionAuth*.test.ts` calls that omit
   the new arg throw an ArgumentValidationError and still "pass" their
   expect-throw. Add the arg to those calls so they keep testing the guard.
3. **The E2E head-of-run reset cannot unblock a refused deploy.** It runs
   after `convex deploy` has already validated existing rows. What protects
   a PR preview is that a never-pushed branch gets a fresh, empty preview on
   its first push; check `git ls-remote --heads origin` before promising that.

**Why:** these are the parts a "flip the schema and the doc validator"
plan misses; each one passes typecheck and most of the unit suite.

**How to apply:** for any tightening, grep every validator that mentions the
field and classify each as args-only (tighten), returns-over-stored-rows
(must stay loose until the data is clean) or shared (handler check only).
Related: [[strict-returns-drift-is-invisible-to-typecheck]].
