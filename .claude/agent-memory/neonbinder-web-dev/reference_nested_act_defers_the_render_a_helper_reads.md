---
name: nested-act-defers-the-render-a-helper-reads
description: A test helper that clicks then queries the DOM sees stale output when the caller wrapped it in `await act(async () => …)`; the outer act batches the render until it ends
metadata:
  type: reference
---

`fireEvent.click` wraps itself in `act`, but inside an OUTER `await act(async
() => { … })` React batches every update until that outer scope resolves. A
helper like "press Save, then accept the confirm step if it appeared" therefore
finds no confirm step when the call site wrapped it in act, and the test fails
as if the step never opened (onConfirm "called 0 times").

**How to apply:** give such helpers two forms: a sync one for bare call sites,
and an async one that does its own `await act(async () => fireEvent.click(x))`,
queries, then acts again for the second click. Replace
`await act(async () => { helper(x) })` with `await helperAsync(x)`.
Example: `components/SetSelector/press-save.ts` (NEO-339's Reconcile
"Leave N sets unpaired?" step), used by the SetSelector form tests.
