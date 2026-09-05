---
name: patterns-aria-disabled-focus-park
description: This codebase deliberately uses aria-disabled (never native disabled) on buttons inside popovers that close on blur/outside-click — native disabled force-blurs to <body> and the popover's own close-on-blur handler reads that as "focus left", closing the popover and discarding any error state
metadata:
  type: pattern
---

Seen in `components/SetSelector/TeamPicker.tsx`'s inline "+ Create team" /
"Create team <name>" submit button (NEO-208, extended in NEO-236's two-field
create form). The component's own comment (search `NEO-208` in that file) spells
out the mechanism: this popover closes itself whenever focus leaves its root —
either a `pointerdown` outside the root, or a `handleRootBlur` that checks
`document.activeElement` after a deferred tick. A **natively `disabled`**
element that currently has focus gets force-blurred straight to `<body>` by the
browser the instant `disabled` flips true; `handleRootBlur` sees that as "focus
left the picker" and closes the popover, taking any in-flight `createError`
message with it — before the async mutation has even settled.

**The fix already in place, and the one to keep recommending:** `aria-disabled`
instead of native `disabled`. It conveys the same state to AT (announced as
"dimmed"/"unavailable" by NVDA/JAWS) without ever forcing a blur, so the button
stays mounted, focused, and part of the DOM for the whole request — and the
popover stays open long enough for a refusal to render.

**The trade-off this creates, worth checking on every such button:**
`aria-disabled` — unlike `disabled` — does NOT block the click handler or
Enter/Space activation. The button is still fully operable while
"aria-disabled". That means the handler itself MUST guard re-entry
(`if (creating) return;`) AND must give feedback for every other reason it might
no-op (e.g. an empty required field) — a bare early `return` with no
`setCreateError(...)` is a silent dead end for a keyboard/screen-reader user who
just activated a control that LOOKS clickable and IS clickable. See
`patterns_status_message_live_regions.md` for the announcement-side half of this
(role="alert" + clear-before-retry).

**Do not recommend switching `aria-disabled` back to `disabled` on this shape**
— it would reintroduce the exact bug NEO-208 fixed. `PlayerPicker.tsx` mirrors
this popover layout (per `TeamPicker.tsx`'s own docstring) and likely shares the
same convention — check it for the same pattern before assuming it needs the
`disabled` "fix".
