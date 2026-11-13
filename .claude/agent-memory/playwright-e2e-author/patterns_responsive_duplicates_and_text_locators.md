---
name: patterns_responsive_duplicates_and_text_locators
description: getByText matches CSS-hidden twins (a phone list beside the wide line), role locators skip them; use filter({ visible: true }) for text, and a project branch only for the size assert
metadata:
  type: feedback
---

A responsive screen often renders BOTH a phone variant (`sm:hidden`) and a wide variant (`max-sm:hidden`)
of one thing. Role locators (`getByRole`) skip the `display: none` copy, but `getByText` matches the DOM
text of both, so `getByText(/^\+\d+ more$/)` is a strict-mode violation on the Boards cards (two
elements: "+14 more" and "+11 more").

**Why:** NEO-464 `demo-board-needs-open-cards` failed on mobile only, from the text locator.

**How to apply:** for text that exists in two responsive copies use
`getByText(...).filter({ visible: true })` (Playwright 1.51+, installed 1.63), or prefer a role
locator. A spec for such a block can share one flow for both projects and branch on `isMobile` only for
the layout facts (chip count, `boundingBox()` >= 44 px, no `list` on the wide line); the click-open-panel,
Next card and Back-with-focus-return steps stay common.

Also: a panel opened by a dashboard card link shows its position as a status line ("Card 6 of 15, <title>"),
so match `getByText(new RegExp(`^Card 6 of ${n}\\b`))`, never `exact: true`.
