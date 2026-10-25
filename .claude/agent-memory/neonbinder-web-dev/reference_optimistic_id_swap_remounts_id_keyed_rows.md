---
name: optimistic-id-swap-remounts-id-keyed-rows
description: A Convex optimistic row (`optimistic:N` id) is swapped for the server id when the write lands; anything keyed or opened by copy.id remounts/closes under the pointer — carry the key with final/lineKeys
metadata:
  type: reference
---

`apps/web/app/collection/final/data/convexStore.ts` draws new lines (a split,
an add, an undo's re-split) ahead of the server under an id from
`optimisticId()` (prefix `OPTIMISTIC_ID_PREFIX` in `final/lineKeys.ts`). When
the mutation resolves the optimistic update is dropped and the server's row,
with its real id, takes its place in the same render.

So a `<li key={copy.id}>` remounts and any panel state stored as `{ id }`
closes at that moment: a button the user is pressing detaches mid-click
(NEO-359 E2E `binders-move-fold-trade-want`, red on desktop and mobile).

**How to apply:** key line rows with `useLineKeys(lines)` and store open-panel
state by that key (see `CopyList` in `CardDetail.tsx`). It carries a vanished
optimistic line's key to the new real line with the same signature (or the one
left over). Content-only keys were rejected: they remount on every edit/move.
Also post a write's status (e.g. "Undone.") only after the write resolves, never
before — see `runUndo` in `FinalCollectionPage.tsx`. A test has to rerender
with the swapped id and assert the SAME element (`toBe`), not just presence.
Related: [[convex-mutation-resolves-after-queries-reflect-it]].
