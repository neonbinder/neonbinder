---
name: patterns-neo308-client-chunked-cap
description: Client-side chunking over a server per-call cap (NEO-308 Group Parallels) — what to verify when a cap constant moves into a shared convex/ module the SPA also bundles
metadata:
  type: project
---

When a per-transaction cap moves into a shared module under `apps/web/convex/`
that Vite also bundles (NEO-308 `parallelGroupingPlan.ts`):

- The bound is still the server check (`> CAP` → ConvexError before any read),
  and it must sit AFTER `requireAdmin`. A client chunker is convenience, never
  the guard; a hostile caller looping many ≤cap calls is the same surface the
  public mutation always had.
- The shared module must hold no runtime imports (type-only `import type` from
  `_generated/dataModel` is erased) and no `process.env`, and must export no
  registered function. Plain exported consts/functions in a convex/ module are
  not callable — Convex registers only query/mutation/action exports.
- Pin the cap VALUE with a literal in the server test (applyParallelGroupings
  test asserts `tooMany(200)`), so raising the shared constant goes red.
- Committed `convex/_generated/api.d.ts` enumerates every module; a new
  convex/ file without regenerated codegen is drift (not a security finding).
- Integrity of a split plan rests on per-call validation against the live tree,
  not on the client's ordering; a mis-ordered or forged split can be refused
  but cannot bypass a per-call check.

Related: [[patterns-neo296-transaction-bounds]], [[public-function-auth-registry]].
