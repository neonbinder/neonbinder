---
name: persisted-error-alert-on-mount
description: role="alert" on a box driven by a server-stored error status fires on every page load / remount, once per cascade column — gate assertiveness on this session's own failed attempt (NEO-450)
metadata:
  type: feedback
---

A conditionally mounted `role="alert"` whose condition is a *stored* status
(e.g. set builder `selectorSyncStatus.status === "error"`) announces stale
state, not an event: Convex queries resolve after first paint, so every column
with a stored error inserts its alert dynamically on load/deep link/refresh,
N assertive alerts in one burst. It also re-announces whenever an unrelated
branch swap (custom form open/cancel) remounts it.

**Why:** role=alert is for a time-sensitive event the user caused or must act
on now; 4.1.3 is satisfied by role=status. Stale state on a collapsed ancestor
column is not urgent.

**How to apply:** recommend alert only when THIS mount saw the attempt fail
(await the action's result, e.g. ensureSelectorOptions returns
`reason: "error"`, bump a counter, `key={counter}` so a repeat failure
remounts and re-announces even if the client never observed the intermediate
"syncing" state); otherwise role=status (intake.tsx role/key pattern, see
[[live-region-role-pattern]]). Check the E2E helper first: a spec locating
`getByRole("alert")` breaks when the role goes conditional
(playwright/support/set-builder.ts `columnSyncError`). Also pair the retry
button to the box with aria-describedby and restore focus to the retry
button after the syncing panel goes away ([[focus-park-pattern]]).
