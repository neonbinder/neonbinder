---
name: marketplace-sentinel-options-get-adapter-predicates
description: A marketplace "no-filter" option (SL's All Brands brand id, BSC's `base` variant slug) is recognised by an env-free adapter-side predicate on the id, never by a schema flag or the row name; the NB role lives on the NB row
metadata:
  type: project
---

A marketplace sentinel option is recognised by an ID predicate in an env-free
module (`convex/bscFacets.ts` `isBscBaseVariantId` is the precedent; the SL
brand-axis "All Brands" id gets the same shape), and the NB behaviour it
implies is a flag on the NB row (`metadata.isBrandUnknown`, `isBase`) stamped
once at creation.

**Why:** Invariant 4 forbids keying NB behaviour on a marketplace name, but
"marketplace refs may be read inside the sync/adapter boundary to route the
marketplace's own update". A predicate on the slot id is that reading; a
name match on `value` is the forbidden one. The one-marketplace E2E fixture
(Hockey 1995) proved the sentinel row is SUPPLIED by SportLots' brand list,
not minted by NB, so the routing has to happen where the option arrives.

**How to apply:** When a plan needs "is this the marketplace's all/none
option", put the constant + predicate beside the adapter (FE-importable, no
`process.env`), route the option inside `fetchAggregatedOptions` /
`storeSelectorOptions`, and keep the option's id in `returnedIds` so the
NEO-211 unlink pass never strips it from the (possibly many, NEO-137 M:1)
rows that hold it. `selectorOptions.ts` is a single-owner file in any
delegation table; new functions go in new modules.
