---
name: raf-focus-request-clear-by-identity
description: A focus request held in state and run in requestAnimationFrame must clear itself with a functional update keyed on identity, or a stale frame wipes a newer request; happy-dom's el.blur() fires no focusout
metadata:
  type: reference
---

Pattern for parking focus after the control in use unmounts (NEO-358 collection a11y pass): hold the request in STATE (`{ copyId, into }`), run it in an effect's `requestAnimationFrame`, then clear it.

Clear it with `setX((cur) => (cur === req ? null : cur))`, never `setX(null)`. An earlier request's frame can fire after a newer request was queued but before React committed it (an async write's `.then` sets the new one); a bare `setX(null)` in that frame batches after it and silently drops the newer move. Seen as "Save copy never returned focus to Edit" while Cancel (sync) worked.

Reading a ref in render to decide "is the row gone yet" fails `react-hooks/refs`; keep the pending move in state. A ref passed as a prop and mutated in an effect fails `react-hooks/immutability` unless the prop name ends in `Ref`.

Test side: in happy-dom `el.blur()` does not dispatch `focusout`, so a document `focusin`/`focusout` hold (e.g. pausing a status-line timer) never releases. Move focus to another element instead (`act(() => other.focus())`). An element you held may also have been replaced by a re-render (a toggle's pressed/unpressed branches), so focus something stable such as a search box.

Related: [[reference_ref_cleanup_sees_focus_before_removal]], [[reference_router_navigation_is_a_transition]].
