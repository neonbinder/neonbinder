---
name: occ-window-moves-to-a-query-behind-an-action
description: A mutation that scans a wide window to write a few rows loses OCC to concurrent writers; split it into public action -> internal query (choose ids) -> internal mutation (get + re-validate each id), and pin the read set with a ctx.db Proxy
metadata:
  type: reference
---

A Convex mutation that opens a range (e.g. a 200-row batch page) and writes a handful of rows in it
carries the WHOLE range in its OCC read set. Any concurrent writer touching the range (a workpool
patching rows, inserts at an open-ended tail) invalidates it, and under a burst it exhausts its retries.

The house fix (NEO-301, `entityReviewQueue.recordAllRemainingAs*`): keep the public name/args/return,
make it an `action` that runs `requireAdmin(ctx)` itself (it only reads `ctx.auth`, which actions have),
then `ctx.runQuery(internal.…listX)` to choose ids + cursor, then `ctx.runMutation(internal.…decideX)`
with `callerId`. The mutation `db.get`s each id and re-runs the SAME predicate the query used
(share one helper) so a stale candidate is skipped, not written. Pin both internal halves' declaration
keyword in `publicFunctionAuth.test.ts` — they trust a `callerId` argument.

**Why:** convex-test runs transactions serially, so no behavioural test can show the conflict; only a
structural read-set pin can.

**How to apply:** export the mutation's `…Impl(ctx, args)`, run it in `t.run` with `{...ctx, db: Proxy}`
where `query(table)` returns a proxied builder whose `withIndex(name, range)` records `name` and replays
`range` against a recorder (eq fields vs any inequality), and `get(id)` is logged. Assert the forbidden
index never appears, and assert a read you EXPECT does appear so the recorder is proven live. Bite-proof
by putting the old `.take()` back. Client side: `useAction` gives no query-consistency guarantee on
resolve (a mutation does), so a reactive loop keyed on `useQuery` may see one stale snapshot after the call.
Related: [[reference_convex_test_transaction_limits_pin_the_read_set]].
