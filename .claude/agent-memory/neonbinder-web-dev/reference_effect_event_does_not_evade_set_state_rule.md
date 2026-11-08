---
name: effect-event-does-not-evade-set-state-rule
description: react-hooks/set-state-in-effect traces through a useEffectEvent, so wrapping a setState in one does not satisfy it; an async function is flagged only for writes before its first await; a one-edge effect takes a justified disable (house practice, ~30 files)
metadata:
  type: reference
---

Moving a synchronous `setPanel(...)` into a `useEffectEvent` and calling that
from `useEffect` still fails `react-hooks/set-state-in-effect`: the compiler
follows the call. The same goes for an async event function whose state write
comes before its first `await`.

**How to apply:** do not restructure to dodge it, and do not add a pointless
`requestAnimationFrame` around the write. If the state truly is an edge on an
outside answer (a query that just loaded, consumed once), use
`// eslint-disable-next-line react-hooks/set-state-in-effect -- <why>`, which is
what the repo does. Check first whether the value can be derived in render.

A related trap: `requestAnimationFrame` callbacks run in FIFO order, so a focus
move queued after a panel's `close()` frame (which returns focus to its opener)
runs after it, and can check `document.activeElement` for the opener. Start the
frame from an effect on state set in the same batch as the panel opening, so the
target field is already in the DOM.
