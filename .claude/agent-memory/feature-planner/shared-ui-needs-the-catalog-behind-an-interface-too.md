---
name: shared-ui-needs-the-catalog-behind-an-interface-too
description: When a hard-coded demo and a real Convex feature share one UI, put the catalog reads behind the store interface too, not just the user's writes — the demo views import fake catalog data directly
metadata:
  type: feedback
---

NEO-358 (2026-10-23): the collection demo (`app/collection/final/`) exposed a
`CollectionStore` interface for the user's copies, but about 20 view files
imported the fake catalog (`getCard`, `getSet`, `cardsInSet`, `searchCards`)
straight from `prototypes/_shared/data`, and called per-card helpers
synchronously in render. Swapping only the store would have left the real
mode reading fake cards.

**Why:** a demo can keep everything in memory and answer synchronously; a
Convex catalog must be read per view (per variant, never a whole set) and
arrives asynchronously.

**How to apply:** plan a hydrated per-view model (`final/data/types.ts`),
read hooks that return `undefined` while loading, async actions that return
an inverse-write undo, and a capabilities object that hides features not built
for real yet. The demo store adapts its fixtures into the same model. Done
criterion: zero imports of the fake catalog from the shared views.
