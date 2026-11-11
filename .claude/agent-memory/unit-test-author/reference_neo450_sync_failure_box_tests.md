---
name: neo450-sync-failure-box-tests
description: NEO-450 EntityColumn failed-sync box tests — locate via the Sync button's aria-describedby (column has several role=status regions), stored vs fresh (alert) failure mocks, hand-rolled thenable to test a re-throwing/null-result handler without an unhandled rejection
metadata:
  type: reference
---

EntityColumn's "Couldn't sync <column>" box (EntityColumn.sync-failed.test.tsx):

- **Locate it through its retry**: read `aria-describedby` off the "Sync <X>" button and
  `document.getElementById` it. A bare `getByRole("status")` is ambiguous (the column has
  other status regions) and `getByRole("alert")` only finds the fresh case.
- **Stored vs fresh**: a mocked status `{status:"error"}` with ensure resolving
  `reason:"synced"` is the stored case (role=status). Fresh (role=alert) needs THIS
  column's ensure/forceSync to resolve `{ran:true, reason:"error", ...}` or reject.
  With items=[] the mount-time ensure runs, so a failing mock makes the mount alert too.
- **Handlers that re-throw or might throw on a bad result**: mock the action to return
  `{ then(onOk, onFail) { try { onFail(err) } catch (e) { caught = e } } }`. A real
  rejected promise turns the re-throw into an unhandled rejection that fails the whole
  vitest run instead of the one test; the thenable keeps it deterministic and lets the
  test assert the re-throw (or its absence, for a null result).
- **Remount re-announce**: compare box nodes before/after a second failed press
  (`not.toBe` + `first.isConnected === false`); same text in place is not re-announced.
- Status transitions are driven by mutating the shared `state.status` and
  `view.rerender(yearsColumn(...))`; the urgent flag's render-time adjustments
  (scope reset, `shown` guard) only run on a render, so each step needs its own rerender.

Related: [[a-green-suite-can-mean-the-test-stopped-testing]] — every behaviour here was
break-checked by a one-line mutant of EntityColumn.tsx, restored with cmp.
