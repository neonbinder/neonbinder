---
name: collection-views-test-on-a-hand-built-store
description: Test the real-mode /collection views by rendering them under a hand-built fake CollectionStore (hooks + actions + capabilities), not a mocked Convex client; add every new store hook to the fake or the suite breaks
metadata:
  type: reference
---

`app/collection/final/RealCollection.test.tsx` (NEO-358) renders the views
inside the store context with a fake store object: read hooks return fixed
view-model data (or `undefined` to test loading), actions resolve with an
`undo`, and capabilities are all off as in real mode. That isolates view
behaviour from Convex and from the demo reducer.

`data/convexStore.test.tsx` separately covers the Convex mapping with a mocked
client, and `data/demoStore.test.tsx` covers the demo adapter.

**How to apply:** when a new hook is added to the store contract
(`final/data/store.ts`), add it to the fake in `RealCollection.test.tsx` and
to both stores. To prove a lazy-load test bites, force the component open and
watch it fail, then restore.
