---
name: public-function-auth-registry
description: convex/publicFunctionAuth.test.ts + publicFunctionAuthGuards.test.ts are the deliberate registry of public-surface auth decisions — new public Convex functions must be added there, not only to colocated tests
metadata:
  type: project
---

`apps/web/convex/publicFunctionAuth.test.ts` and
`convex/publicFunctionAuthGuards.test.ts` exist as the **registry** of every
public-surface auth decision (NEO-154, NEO-202, NEO-208). Their own docblocks
say the decisions "live here as assertions" because a decision recorded only in
a ticket comes undone the next time someone copies a neighbouring function.

They deliberately do **not** enumerate the whole API and fail on anything
unguarded — an allowlist is where a real hole would get parked to make CI green.
That is exactly why a new public function has to be added by hand.

**Why:** a branch can ship auth coverage in a colocated test
(`players.management.test.ts`, `teams.search.test.ts`) and still leave the
registry silent, so the two files pass unchanged while the public surface grew.
Green output from those two files is therefore **not** evidence that new
functions are gated — check the diff for whether they were touched.

**How to apply:** on any branch adding `query`/`mutation`/`action` exports,
diff those two test files. If they are unchanged, say so explicitly in the
audit and recommend one assertion per new function (anonymous + signed-in
non-admin), even when colocated tests already cover it.

Related: [[convex-auth-boundary]].
