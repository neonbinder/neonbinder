---
name: interactive-controls-carry-no-dom-id
description: The E2E suite finds controls only by role + accessible name, label, visible text, placeholder, title or alt — never a DOM id — so an interactive control needs a distinct accessible name, not an id; when code needs to find a control, use a data attribute plus a scoped querySelector; ids belong on non-interactive ARIA targets
metadata:
  type: reference
---

The Playwright suite (`apps/web/playwright/GUIDE.md`) locates only by what a user
perceives. A control with no distinct accessible name is a product gap the suite
cannot work around, and an `id` or test id added "for the test" is forbidden.

**How to apply:**
- Give every interactive control a distinct accessible name (visible text, a label,
  or an `aria-label`). When two siblings would read the same, reword one (do not
  suffix with an index).
- Interactive or focusable elements (buttons, tick boxes, focusable `role="group"`
  scrollers) carry NO DOM id unless ARIA requires one (below).
- When code needs to find a control (focus management, arrow-key navigation), use a
  data attribute plus a scoped `querySelector` (e.g. `data-grouping-control`), never
  `getElementById`.
- `aria-controls`, `aria-labelledby`, `aria-describedby` and `aria-activedescendant`
  still need ids. Put the id on the non-interactive target: a summary `<p>`, a
  heading, an always-rendered wrapper around a focusable list. `aria-activedescendant`
  options must carry ids; their accessible name still comes from their text or
  `aria-label`, so the spec's handle survives.
- Pin it with a unit test that asserts `getAttribute("id")` is null on each control.
- Keep the shared `Input` primitive id-free; a spec finds its inputs by label.

(Under the retired Maestro driver an id hid the `aria-label` from every `id:`
selector; that mechanism is gone, but the no-id rule and the distinct-name rule stand.)

Related: [[disambiguate-duplicate-aria-labels-by-rewording]]
