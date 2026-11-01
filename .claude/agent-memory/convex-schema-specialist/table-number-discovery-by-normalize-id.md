---
name: table-number-discovery-by-normalize-id
description: Learning an EMPTY table's number from inside a Convex function is a normalizeId probe scan; it is a SYNC syscall so the budget it spends is the 1 s execution time, sized as numbers x pending tables per query, and convex-test cannot pin it
metadata:
  type: project
---

`convex/referenceSeed.ts` (NEO-408) finds a table's NUMBER without a snapshot
export: `ctx.db.normalizeId(table, encodeId(n, zeros))` is non-null exactly
when `n` is that table's number (`lib/convexIdCodec.ts`). Facts that size it:

- `normalizeId` is `performSyscall` (sync, `database_impl.js`), not an async
  db op. It costs no index range, no document read and none of the
  "too many system operations" budget ([[convex-two-transaction-limits]]).
  What it spends is the query's **1 s execution time**: ~115k probes of JS +
  JSON cost ~50 ms in Node alone, before the V8/Rust crossing per call.
- The unit of cost is **probes = numbers scanned x tables still pending**,
  not numbers. A chunk constant sized in numbers (4096) silently multiplies
  by the table list the loader passes (8 bundle + ~20 dependants on a fresh
  preview, all empty). Cap probes per query (`floor(budget / pending.length)`),
  not numbers.
- User tables are numbered upward from 10001 on current deployments
  (`NUM_RESERVED_SYSTEM_TABLE_NUMBERS` = 10000 in convex-backend; legacy
  deployments may sit lower). Scan [10001, ...) first and wrap to [1, 10001)
  only if something is still pending; a fresh preview's ~45 tables sit in
  10001..~10060 and one query finds them all.
- Tables defined in the schema get a number at schema push, rows or not, so
  the probe works on an empty table.
- `convex-test` ids are `table;n` strings with no table number, so a
  convex-test test of the discovery is vacuous (`tableNumbers` comes back
  `{}`); pin the codec against the loader's codec in a plain vitest and say
  in the test that CI's seed is what exercises the real lookup.
- A cheaper path to check before scanning: the CLI's `npx convex data` lists
  tables through the system UDF `_system/cli/tables` with the admin key; if
  its rows carry the number, one call replaces the scan. Unverified.

Pagination from an action (`ctx.runQuery` of a `.paginate()` page in a loop)
is fine: each runQuery is its own execution, so the one-paginate-per-execution
rule is met, and the backend cuts an oversized page (`pageStatus:
"SplitRequired"`, default byte budget) with a `continueCursor` after the cut,
so a count loop that follows `continueCursor` stays exact on wide rows.
Related: [[armed-backfill-models-have-no-cursor]].
