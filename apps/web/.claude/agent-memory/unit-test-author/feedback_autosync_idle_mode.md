---
name: feedback_autosync_idle_mode
description: EntityColumn auto-sync fires when useQuery returns [], hiding idle buttons — always return undefined to keep column in idle mode during component tests
metadata:
  type: feedback
---

Return `undefined` from `mockQuery` (not `[]`) when testing EntityColumn in idle mode.

**Why:** EntityColumn's auto-sync effect has the guard `if (items === undefined) return` — a loading-state query keeps the column idle. Returning `[]` (resolved-but-empty) triggers the auto-sync logic which switches `mode` to `"sync"`, rendering `renderForm()` and hiding the `+ Custom` and sync buttons entirely.

**How to apply:** In any component test that needs the EntityColumn idle-mode buttons visible (Sync, + Custom), set `mockQuery.mockReturnValue(undefined)` in `beforeEach`. Only use a non-empty array fixture if testing the submit behavior that depends on existing items (see `EntityColumn.custom-select.test.tsx` which correctly returns `EXISTING_ITEMS` because it needs them for the match logic, not for navigating to idle mode).
