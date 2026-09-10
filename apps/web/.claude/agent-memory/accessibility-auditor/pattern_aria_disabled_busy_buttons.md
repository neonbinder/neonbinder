---
name: pattern-aria-disabled-busy-buttons
description: The admin/*Management.tsx screens disable sibling buttons via native `disabled` while a mutation is in flight, which blurs focus to body on every click
metadata:
  type: project
---

Recurring pattern across components/admin/{Franchise,Team,League,Player}Management.tsx:
a list of buttons (candidate picker, "Remove X from Y", "Re-enrich", etc.) all share one
`busy` state variable and are rendered with `disabled={busy !== null}`. Clicking one sets
`busy` synchronously, which re-renders THAT SAME button as `disabled` — and a disabled
element cannot hold focus, so the browser blurs it to `<body>` immediately. This happens
on literally every click of the action, not just an edge case.

Fix already documented by the team itself in components/modules/NeonButton.tsx (~L38-48):
use `aria-disabled` instead of native `disabled` so the button stays in the tab order and
keeps focus, and guard the click handler manually (`if (busy !== null) return;`) since
aria-disabled does not itself block clicks. NeonButton already supports this for callers
that pass `aria-disabled`; plain `<button>` elements (e.g. the "Remove <team>" links in
FranchiseManagement.tsx) need the guard added by hand since they don't go through NeonButton.

This is a repo-wide convention, not unique to any one screen — when auditing a new
admin/*Management.tsx file, check for this shape (`disabled={busy !== null}` on a per-row
button inside a `.map()`) and flag it, but frame it as "matches an existing pattern, still
worth fixing" rather than a novel regression unique to that PR. See
[[workflow_sibling_crosscheck]].

**Validated fix (NEO-254, FranchiseManagement.tsx):** flagged this for the per-row "Remove
<team>" buttons; the writing agent extracted a shared `RemoveTeamButton` component using
`aria-disabled={unavailable}` + `onClick={() => { if (unavailable) return; ... }}`, with the
rationale written into the component's own docstring (citing this exact focus-loss mechanism)
and a unit test asserting siblings get `aria-disabled="true"` (not native `disabled`) and fire
no mutation on click while busy. This is the reference implementation to point to next time
this pattern comes up in League/Team/Player Management too.
