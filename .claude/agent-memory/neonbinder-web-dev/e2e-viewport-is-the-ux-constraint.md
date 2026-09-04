---
name: e2e-viewport-is-the-ux-constraint
description: Admin screens are judged at the CI E2E viewport (1024x629); put status/feedback next to the control that produced it, because role="status" hides sighted-user gaps
metadata:
  type: feedback
---

On admin master-detail screens, render a status/confirmation message adjacent to
the control that produced it — not in a single page-level status line — and size
the judgement against the CI E2E viewport, **1024x629**, not a full desktop
window.

**Why:** CI E2E on PR #219 (NEO-212) surfaced this in `PlayerManagement`. Every
message, including the detail panel's "Saved {name}." and "Could not save that
player.", was rendered by page-level `status` state at the top of the page,
while Save / Re-enrich sat at the bottom of the right-hand detail column. At
1024x629 the confirmation landed ~600px above the button and off-screen: a mouse
user pressing Save got no visible feedback, and a failed save reported its reason
somewhere they never looked. `role="status"` meant assistive tech had been told
the whole time, which is exactly what hid the defect from review — an a11y
attribute can mask a *sighted*-user gap.

**How to apply:** When adding or reviewing feedback text on `components/admin/*`
(and any master-detail panel), ask where the triggering control is at 1024x629.
Detail-panel actions get a local status line under their action row; only
messages that report on something the top line already sits above (e.g. the add
form's "Added {name}." reporting on the list) stay page-level. Keep exactly one
live region per message — never duplicate into both.

Two follow-on traps seen here:
- Maestro assertions that scrolled `direction: UP` to find a message must flip
  when the message moves down the page; `extendedWaitUntil: visible:` does not
  scroll at all and only matches on-screen text.
- Message text is byte-matched by E2E regexes. `Saved ${name}.` against a
  fixture named "Ken Griffey Jr." renders "Saved Ken Griffey Jr.." — the doubled
  stop is real and unit assertions must include it.
