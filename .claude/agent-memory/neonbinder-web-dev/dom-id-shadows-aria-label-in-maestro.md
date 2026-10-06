---
name: dom-id-shadows-aria-label-in-maestro
description: maestro-web resource-id is `node.id || ariaLabel`, so never put a DOM id on an element whose aria-label an E2E flow targets; move the id to a non-interactive wrapper
metadata:
  type: feedback
---

Never give a DOM `id` to an element that also carries an `aria-label` a flow
targets. maestro-web builds `resource-id` as `node.id || ariaLabel`, so the id
wins and the flow can never find the label (NEO-313: a `useId` on the sport
listbox for the trigger's `aria-controls` hid "Choose a sport", two flows red).

**Why:** the failure is silent in unit tests and only shows up as an E2E
"element not found" in CI.

**How to apply:** when `aria-controls`/`aria-describedby` needs an id on a
labelled control, put the id on a non-interactive wrapper (move absolute
positioning to the wrapper so visuals stay identical). A quick audit: scan JSX
opening tags for both `id=` and `aria-label=`. Elements named by
`aria-labelledby` or a `<label htmlFor>` are not affected by this rule.

**aria-activedescendant is the exception you cannot route around** (NEO-224):
every option it points at MUST carry a DOM id, so a labelled option (the
pinned "All Brands — every set in <year>") stops answering `id:` selectors.
Keep the listbox/popup label safe with the wrapper trick, and tell the
coordinator which flows targeted an option's aria-label so maestro-e2e-author
moves them to visible text.
