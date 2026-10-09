---
name: reference-live-validation-without-keystroke-renders
description: To validate a commit-on-blur draft live without re-rendering a big dialog per keystroke, keep drafts in a ref and swap a snapshot state only when the answer changes — reading ref.current in useMemo fails lint (react-hooks/refs)
metadata:
  type: reference
---

apps/web lints `.tsx` with `react-hooks/refs`: `useMemo(() => f(ref.current), [sig])`
is a lint ERROR ("Cannot access refs during render"), even with a signature
state as the dep trigger.

Pattern that passes (NEO-325 ReconciliationModal title-clash check):
- drafts live in `draftsRef` (written only in the row's onChange handler);
- a second ref mirrors the snapshot last put in state;
- in the handler, compute the answer for the shown snapshot and for the live
  drafts against the CURRENT committed state; `setSnapshot(new Map(drafts))`
  only when they differ, and always on commit/revert (`draft === null`), so
  a later reducer change never reads a stale draft for a committed row;
- render computes from `(state, snapshotState)` — no ref read.

Also: Maestro web cannot read `disabled` / `aria-disabled` /
`aria-describedby` (TreeNode.enabled is null on web). A blocked button gets
`title={reason}` while blocked and no aria-label — the title becomes its
Maestro id. See [[maestro-resource-id-is-id-or-aria-label]].
