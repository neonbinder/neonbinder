---
name: virtual-chain-previews
description: Read-only previews of a sync/staging action share its read half and run it over a virtual chain; unconfirmed SportLots ids on a chain node count as set linkage, so keep them off validation fetches
metadata:
  type: reference
---

When a read-only preview needs what a staging action computes (NEO-339:
`previewSetStructure`, `previewCardChecklist`), extract the action's read half
into a chain-scoped helper (`fetchRawOptionsForChain`, `fetchAndMatchChecklist`)
and call it from both. Do not write a second matcher.

- **Hoisted values survive a throw through a `report` object** the helper fills
  as each value becomes known (`attachedSides`, `pausedSides`, call counts).
  The staging action copies it out in a `finally`, so its outer `catch` returns
  exactly what it did before.
- **A row that does not exist yet becomes a virtual chain node** that carries
  only ids a marketplace just returned, on slots, tagged the way the real
  writer tags them (`variant` on a variantType node). Then `resolvableSides`,
  `resolveBscFacetFilters` and the adapters run unchanged, and no NB name is
  used to build a query.
- **Gotcha:** `resolvableSides` counts ANY SportLots id at or below the setName
  row as proof the set is linked (`SL_LINKED_SET_FETCH_LEVELS`). If a
  validation fetch puts a client-supplied, still unconfirmed SL id on a node,
  that id unlocks the SportLots list it is being checked against. Leave
  unconfirmed ids off the chain used to validate them, and add a side's ids
  only when that side's list is needed. Otherwise you make extra marketplace
  calls.
- **A decision the staging MUTATION makes with DB reads** (NEO-333's
  whole-name-first team choice in `resolveCandidateTeams`) is shared the same
  way: widen the helper's ctx to `QueryCtx | MutationCtx` and expose it through
  an `internalQuery` the preview calls (`previewCandidateTeams`). Never mirror
  the rule in the action's memory. An in-memory mirror drifted silently the
  moment the mutation's rule changed upstream, and only the parity test caught it.
- Prove it with parity tests. Run the preview, snapshot every table
  (`Object.keys(schema.tables)`) to show nothing was written, then run the
  staging path on the same fixture and compare buckets in order-free,
  undefined-free form.

Related: [[pure-router-rows-carry-nb-value]], [[convex-test-files-are-not-typechecked]].
