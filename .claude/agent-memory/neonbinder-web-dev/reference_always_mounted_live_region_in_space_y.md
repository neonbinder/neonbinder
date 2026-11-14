---
name: reference_always_mounted_live_region_in_space_y
description: An always-mounted empty live region as a direct child of a space-y parent adds a phantom gap; nest it beside something with height, and never add an sr-only copy of a line specs read with getByText
metadata:
  type: reference
---

Tailwind's `space-y-*` puts its margin on every child, so a zero-height, always-mounted `role="status"` wrapper still pushes the page by the gap while it is empty. `empty:hidden` is not the fix: `display: none` takes the region out of the accessibility tree, which is what mounting it early was meant to avoid.

**How to apply:** wrap it with a sibling that already has height (a `min-h-5` status line works), and only give the region's own box its padding, border and margin while it has content.

The line has to be one element. An extra `sr-only` copy makes `getByText(line)` a strict-mode violation in Playwright. A control sitting next to the line goes outside the region, so its name isn't read as part of the announcement.

Related: `getByRole("button", { name: "New run" })` is a case-insensitive substring match, so it also hits "Start a new run". Specs need `exact: true` when both are drawn.

**Two cheaper escapes (NEO-536):** Tailwind v4's `space-y-*` and `gap` rules
sit in `:where(...)`, zero specificity, so a plain `mb-0` on a section that has
nothing to draw cancels its own `space-y` gap while its empty live region stays
mounted. Inside a flex column or wrapping row, an always-mounted `role="alert"`
can carry `empty:-mt-2` (match the gap) so it takes no room until it has text;
render `{error}` (null), not `{error ?? ""}`, so the element is truly `:empty`.
