---
name: reset-loop-has-a-fifth-consumer
description: Adding a table to runSetBuilderReset touches FIVE places, not the four the convex-schema-specialist checklist lists — publicFunctionAuth.test.ts pins each reset*Batch as internalMutation
metadata:
  type: reference
---

`.claude/agent-memory/convex-schema-specialist/transient-side-table-checklist.md`
lists four consumers for a table added to `runSetBuilderReset` (the `steps`
array + `SetBuilderResetResult` + the `returns` validator + the `counts`
object; the four `toEqual` blocks in `resetSetBuilderData.test.ts`;
`deleteSelectorOption`'s transient sweep; the ops runbook).

There is a **fifth**: `convex/publicFunctionAuth.test.ts` carries a
`test.each` list pinning every `reset*Batch` as
`export const <name> = internalMutation({`. That list is a string check over
the source, so a batch missing from it is simply unprotected — nothing goes
red if a future edit turns it into a public `mutation`, which is an
unauthenticated table wipe (these batches carry no identity check by design;
the `ALLOW_RESET_SET_BUILDER_DATA` arming flag is the only guard).

**Two traps in the test file itself:**

- The seeded-counts `toEqual` block appears at two different INDENT levels
  (six spaces in the plain tests, eight inside the `test.each`), so a
  whole-block find/replace silently misses one.
- `convex/tsconfig.json` excludes `*.test.ts`, so `npm run typecheck` is green
  even when every call site is stale — the vitest run is what catches it.

**How to apply:** when wiring or unwiring a table in the reset loop, grep
`reset.*Batch` across `convex/*.test.ts` before declaring it done.
Related: [[reference_convex_typecheck_excludes_test_files]],
[[entity-review-batch-is-a-grouping-not-a-table]].
