---
name: listitem-has-no-name-from-content
description: Playwright and testing-library give a <li> no accessible name from its text; a spec that targets getByRole("listitem", { name }) needs an aria-label on the li
metadata:
  type: reference
---

`listitem` is not a name-from-content role. Playwright's `allowsNameFromContent` only names a listitem from its text when it is a *descendant* of the element being named, never as the target. So `getByRole("listitem", { name: "Read Near Mint, done" })` matches nothing unless the `<li>` carries `aria-label`. testing-library (dom-accessibility-api) behaves the same way.

**Why:** found during NEO-415. The sync-steps ledger needed each step addressable as "label, state". The house spec idiom is `getByRole("listitem").filter({ hasText })`, which needs no name, but a contract asked for named items.

**How to apply:** when a list item must have an accessible name:
- Put `aria-label` on the `<li>`.
- Keep the visible text saying the same words, with the state in an `sr-only` tail, so browse-mode readers (NVDA ignores `aria-label` on a plain li) hear the same thing.
- Never wrap the content in `aria-hidden` to stop VoiceOver reading the text twice. A doubled read is better than a silent item.
- In a vitest, read the name from `getAttribute("aria-label")` (see [[happy-dom-pads-inline-span-in-accessible-name]]).
