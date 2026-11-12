---
name: sr-only-suffix-in-a-name-is-unstable
description: An sr-only span appended inside a role=heading (or any name-from-content element) does not give a predictable accessible name in happy-dom; name the element with aria-label instead
metadata:
  type: reference
---

Appending `<span className="sr-only">, not matched to a set</span>` inside a
`role="heading"` span to tell two same-text headings apart rendered the right
`textContent`, but `getByRole("heading", { name: "Title, not matched to a set" })`
found nothing in the apps/web `components` project (happy-dom): accname treats the
nested span as block-level and pads it with spaces. Real browsers can do the same,
because `sr-only` is `position: absolute` (computed display becomes block).

**How to apply:** when a name-from-content element needs extra words only a screen
reader hears, put the whole name in `aria-label` on that element (visible text
unchanged) rather than an sr-only child. An sr-only child is fine where only
`textContent`/`getByText` matters (a chip's explanation), not where a spec
matches the role's accessible name exactly. Seen on NEO-509's Pick List twin
set dividers. Related: [[interactive-controls-carry-no-dom-id]].
