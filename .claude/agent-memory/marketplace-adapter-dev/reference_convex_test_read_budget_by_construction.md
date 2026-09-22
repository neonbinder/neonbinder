---
name: convex-test-read-budget-by-construction
description: How to pin a Convex read budget in convex-test — wrap ctx.db in a Proxy inside t.run and count query/get calls; t.run cannot return a Map; a batch helper takes an optional pre-read index and both paths are pinned to agree; the set sync treats an EMPTY BSC list as a failed side, so fixtures need a non-empty one
metadata:
  type: reference
---

A mutation that calls a per-row helper which re-reads a whole subtree per
row (the NEO-237 `insertSetWithBaseFromSl` shape: sibling clash + "exists
under another brand of the year" per root) blows Convex's per-transaction
document budget at ~200 rows × ~2,700 docs. The house fix, and how to test
it so the budget is asserted rather than hoped:

- **Shape:** the helper takes an optional pre-read index
  (`{ siblingKeys, elsewhereKeys, truncated }` built once per mutation by a
  `build…Index(ctx, parent)` that walks `by_level_and_parent` with a
  `take(remaining + 1)` bound). With the index the helper reads nothing but
  its parent row, and it ADVANCES the index with each row it writes so a
  later row in the batch sees it exactly as a re-read would. Without the
  index it self-reads (kept for single callers). A truncated index is a
  refusal reason, not a guess. The action chunks the batch (40 per
  mutation) and rebuilds the index per chunk.
- **Pin the two paths agree:** two `convexTest` instances seeded
  identically, the same batch through each path, compare an id-free shape of
  every decision and the resulting names. Include a root that clashes with a
  row written EARLIER IN THE SAME BATCH — that is the case the index-advance
  exists for.
- **Count reads by construction:** inside `t.run(async (raw) => …)` wrap
  `raw.db` in a `Proxy` whose `get` trap counts `query`/`get`/`insert`/`patch`
  and binds functions to the target; pass `{ ...raw, db } as MutationCtx` to
  the helper. Assert `query === 0` with the index and `1 + manufacturers`
  for the index build. No timing, no mocks of the DB.
- **`t.run` cannot return a `Map`** ("is not a supported Convex type") —
  inspect the index inside the run and return only primitives/plain objects.
- **Fixture trap in `syncSetsAcrossManufacturers` tests:** the BSC phase
  treats an EMPTY BSC set list as a FAILED side (`failedPlatforms: ["bsc"]`,
  "could not be reached" in the done row), by design. A test that wants a
  clean done row with only the SportLots sentence must give BSC at least one
  set whose name carries the brand prefix.
