---
name: reference-paginated-query-leaves-exhausted-live
description: usePaginatedQuery can leave Exhausted on a live update (split, a page growing past its size), so `status === "Exhausted"` as a render gate unmounts the screen; hold the last full read
metadata:
  type: reference
---

A read-every-page screen gated on `status === "Exhausted"` is not stable once loaded. A live update can grow a page: the hook splits it (`SplitRequired` reports `LoadingMore`), or `isDone` goes false (`CanLoadMore`). The gate then drops to Loading and unmounts everything under it, an open dialog included.

Hold the last full read and draw from it: `useMemo` the read while ready (its identity is stable, `results` is memoized in the hook), then `if (latest && latest !== lastRead) setLastRead(latest)` during render, and draw `latest ?? lastRead`. A `useState`-during-render adjust passes the react-hooks rules where an effect does not. Decisions that need current truth ("that card is gone") gate on `latest`, not the held copy.

Seen in NEO-444, `PublicCollectionPage`'s `OpenBinder`.
