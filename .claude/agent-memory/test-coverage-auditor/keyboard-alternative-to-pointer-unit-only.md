---
name: keyboard-alternative-to-pointer-unit-only
description: A new keyboard path added beside a drag/click target (Tab to a box, Enter/Space places) tends to ship with unit proof only; ask for a live press in the existing spec, plus geometry asserts for viewport-split layouts
metadata:
  type: feedback
---

When a dialog gains a keyboard alternative to a pointer action (a drop box that joins the Tab order while a selection is up, Enter/Space on it does what a click does), builders cover it in the component unit test and the E2E specs keep clicking. That leaves the keyboard path with no live proof on either project, which counts as a user-facing change without E2E (blocker).

**Why:** seen on the Group Parallels two-pane rework (NEO-472): every spec drove the box by click or mouse drag; Tab/Enter lived only in happy-dom.

**How to apply:** grep the dialog's specs for `press(` / `keyboard.press` on the new target. The fix is cheap: in the spec that already ticks rows, `locator.press("Enter")` (or Space) on the box instead of `click()`, then assert the footer count. Same audit: when a layout splits by viewport (side-by-side panes from `md`, stacked on phones), ask for an explicit geometry assert per project (pane x/y relation, the other pane not scrolled) rather than letting the drag parking point imply it. Also check the filter's zero-match empty state has an open assert plus axe. Related: [[one-big-spec-many-screens-axe-gap]].
