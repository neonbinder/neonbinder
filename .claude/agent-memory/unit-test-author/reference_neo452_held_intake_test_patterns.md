---
name: neo452-held-intake-test-patterns
description: Patterns for testing the Add cards held-photos tab (module-store, real Dropzone swap, double-layer guards, focus timing)
metadata:
  type: reference
---

- Tab test mocks the Dropzone with a switch (`realZone`): stand-in for legacy tests, the real zone for drop-driven ones. Cascade mock is one "Pick it" button; `useDrillState` reads a mutable pick.
- The held store is module state: call `clearAllHeld()` in `beforeEach`; vary the user through the mocked Clerk `userId`.
- `pickSet` needs two animation frames: `close()` returns focus to Set in its own frame, then the auto-open effect focuses Min price. To test "collector moved on", use an open run (the answer arrives later) and move focus after the pick, before the run updates.
- "Never release while the gate loads" is guarded in two layers (hook `ready:false` and the tab's `lock.loaded`). A break-check must remove both; one layer alone leaves the suite green by design. Same for `beginSend`'s claim vs the tab's `held.sending`.
- `aria-disabled={false}` renders the string "false": assert `not.toBe("true")`.
- Assigning a module object in a test component's render trips `react-hooks/immutability`; set it in an effect.
- Break-check by exact-string replace and its inverse (never whole-file restore) when another agent edits the same file; `cmp` against a pre-copy after.
