---
name: hmr-context-module-edit-crashes-the-page
description: In a shared worktree, a sibling's edit to a module that creates a React context (collection mode.tsx) HMR-reloads it and the page throws "outside Provider"; reload, it is not your bug
metadata:
  type: reference
---

During a local Vite visual check in a ticket worktree where other builders are editing, the collection page can suddenly show "An error occurred. Please refresh the page." with `useLatestEntry: outside CollectionModeProvider` (or any `useX: outside XProvider`) in the console.

Cause: a sibling saved the module that calls `createContext` (here `app/collection/final/mode.tsx`). HMR re-evaluates it, so consumers get a NEW context object while the mounted provider still holds the old one.

**How to apply:** navigate/reload the page and carry on; only treat the error as real if it reproduces on a fresh load. Related: [[gates-in-a-shared-worktree]].

Also from the same check (quick-entry fields): a field that `select()`s on focus has `selectionStart = 0`, so an "→ at the end of the field moves on" rule must test `selectionEnd === value.length` only, or → collapses the selection and the next digit is typed in front of the old value.
