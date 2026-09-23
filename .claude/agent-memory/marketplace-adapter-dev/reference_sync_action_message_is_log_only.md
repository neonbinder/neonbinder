---
name: sync-action-message-is-log-only
description: A sync action's `message` looks user-facing because a legacy *Form component renders it, but the selector columns are on `useEnsureSync` and never call `renderForm` — the only real surface is the status row set by ensureSelectorOptions
metadata:
  type: reference
---

Before concluding that a Convex sync action's `message` (the
`Synced X (a, b, c)` summary built from a `summary: string[]`) reaches an
operator, check **which render branch the column is on**.

`EntityColumn` renders `useEnsureSync ? newPathContent() : renderForm(...)`.
Every selector column in `SetSelector.tsx` passes `useEnsureSync`, so the
legacy `<XForm>` components it still passes as `renderForm` (e.g.
`SetForm`, which does `setMessage(result.message)` and renders it in a blue
box) are **never mounted**. Grepping for "who renders `result.message`" is
therefore a false positive: those components are dead code kept for the
legacy path, and their own comments say so.

The real user-facing surface for a column sync is the **status row** —
`setSelectorSyncStatus` / `getSelectorSyncStatus`, composed in
`ensureSelectorOptions` from the paused / skipped / partial sentences. A
count that only lands in the action's `summary` is telemetry: logs and the
action return, nothing on screen.

Practical consequence: adding a fact to `summary` costs nothing
user-facing; adding a sentence to the status-row composition is a product
decision. See [[swept-log-markers-are-pinned]] for the log side.
