---
name: patterns-neo300-held-elsewhere
description: NEO-300 subtree walk + heldElsewhere outcome + duplicate-parallel guard — what holds (id-only, admin-only, NB names out), and the three traps to re-check when the grouping/sync code moves
metadata:
  type: project
---

NEO-300 lets both selector stores (`storeSelectorOptions`,
`storeReconciledOptions`) see the rest of a variant type's subtree
(`loadVariantTypeSubtreeElsewhere` in selectorSyncStore.ts) so a row an
operator grouped (insert <-> parallel) is reported as `heldElsewhere` instead
of re-created. `applyParallelGroupings` gained a duplicate-parallel refusal.

**What holds:** all three are `requireAdmin`; no new public function, so no
registry entry is owed. Elsewhere matching is by NB `_id` (tier 0) or a
marketplace id in any slot (tier 1), never by name or card number. A held item
writes nothing. The returned `heldElsewhere` entries carry NB ids and NB names
only; the new log lines carry ids and counts only.

**Traps to re-check:**
- The walk's cost is charged as one op per index RANGE; Convex's binding limits
  for a wide variant type are documents scanned and bytes read, which scale
  with parallels-per-insert. The insert cap (400) bounds ranges, not bytes.
  Past the cap the store silently falls back to the pre-fix rule (a warn log,
  nothing in the result).
- The duplicate-parallel guard uses `sharesMarketplaceId` (ANY slot, EITHER
  side), while NEO-137 treats M:1 as legal. A legal shared id refuses the
  grouping and the operator's only way through is detaching a link — ask
  whether the guard should require identity on every linked side.
- Server heldElsewhere at `parallel` includes the parent insert; the client
  helper excludes it. Neither marketplace serves `parallel` today, so it is
  latent; re-check if a marketplace ever gains a parallel axis.
- Tier-0 elsewhere trusts the client's `existingId` without checking the item's
  ids are on that row: a new marketplace id riding on it is dropped, reported
  under the held row's name.

**How to apply:** when a later ticket adds an outcome kind, a level, or a
parallel-axis marketplace, re-run the four checks above. Store loops fall
through to insert for unknown outcome kinds (see marketplace-adapter-dev
memory `store-loops-fall-through-to-insert`).
