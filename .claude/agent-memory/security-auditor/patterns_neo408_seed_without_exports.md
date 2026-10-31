---
name: patterns-neo408-seed-without-exports
description: Replacing a CLI's snapshot exports with internal Convex read functions run via `npx convex run` — what audits clean (internalQuery = structurally read-only, counts/booleans/ids only) and the three traps (normalizeId is a per-call syscall so an id-probe scan is CPU-bounded by the query budget, a broad catch returning 0 rows is fail-open for an "is it empty now" verify, and "needs no deployed code" claims die the moment the CLI calls a deployed function)
metadata:
  type: project
---

NEO-408 moved the reference-seed loader's two `convex export` round trips into
`convex/referenceSeed.ts` (internalQuery/internalAction) called through
`npx convex run` with the deploy key, no `--identity` (house precedent:
e2e-baseline.sh). Durable rules for the next change of this shape:

- **Reachability.** `internal*` is unreachable from any client; `convex run
  --identity` only reaches public functions. The real gate is the deploy
  credential, so audit the CLI's key guards, not the function. A read-only
  helper needs no arming flag (unlike the NEO-214 armed wipes) — a query
  cannot write, so read-only is structural. Check the `returns` validator
  stays counts/booleans/numbers/ids; a cursor returned action→CLI would be the
  first leak.
- **`ctx.db.normalizeId` is a `performSyscall` per call** (convex
  `server/impl/database_impl.js`). A table-number discovery that probes
  `encodeId(n, zeros)` for n = 1.. against every empty table multiplies
  (candidate numbers × pending tables) syscalls inside ONE query, and on a
  freshly reset deployment every table is empty. Ask for the scan to start
  where user tables actually begin, or to be chunked across queries from the
  action, and for a measured run on a real deployment before merge.
- **A `try { paginate } catch { return {count:0, isDone:true} }` is fail-open
  for the "now empty" verification** (clear) even though it is fail-closed
  for "now holds N" (load). Return an explicit error flag or let the function
  throw; the CLI already treats a non-zero exit as failure.
- **Field names passed as args (`sportIdFields`)** keep the function free of
  schema literals, but an omitted list silently disables the check. Confirm
  the one caller passes the full list and a test pins it.
- When a CLI stops taking exports, every "works with no deployed code"
  statement (header comments, runbooks) about it is now false: a target that
  cannot deploy the branch cannot answer `referenceSeed:*` either.

Related: [[patterns-convex-cli-target-selection]], [[patterns-neo330-reference-seed-ci]],
[[patterns-neo333-split-raw-and-report]].
