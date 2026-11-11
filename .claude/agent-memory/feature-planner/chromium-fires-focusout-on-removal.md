---
name: chromium-fires-focusout-on-removal
description: Chromium (Playwright 1.63, Chromium 153) fires focusout with relatedTarget null when the focused node is removed; happy-dom does not, so focus-tracking refs pass unit tests and fail E2E
metadata:
  type: project
---

Chromium dispatches `blur`/`focusout` on a focused node as it is REMOVED, with
`relatedTarget === null`, while the node is still attached (probed 2026-11-10:
`focusin b, focusout b related=null, active-after body`). happy-dom fires
nothing on removal. So a "focus was inside this column" ref that clears on any
focusout without a related target in the column is wiped by the very unmount
it exists to survive: the park/return never fires in the browser, while every
Vitest case is green (NEO-450, EntityColumn's NEO-260 park and Sync focus
return).

**Why:** a `relatedTarget: null` focusout means "left for nowhere" OR "the node
was unmounted under focus"; only the second is the park case.

**How to apply:** when a plan or diagnosis touches focus parking keyed on
focusout, decide on null-relatedTarget only after the removal settles
(microtask: target `!isConnected` = still ours; else `el.contains(activeElement)`).
Unit tests must emulate Chromium (wrap `Node.prototype.removeChild` to dispatch
focusout on a contained activeElement) or they prove nothing. Also check what
ELSE re-parks focus inside the component (a notice's own visible->hidden park
re-set the ref): stored server state on a per-worktree deployment can make the
spec green locally and red on a fresh CI seed. See
[[open-if-visible-races-the-selection-change]] for the other focus-race shape.
