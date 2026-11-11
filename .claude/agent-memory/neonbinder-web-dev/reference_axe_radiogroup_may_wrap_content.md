---
name: axe-radiogroup-may-wrap-content
description: axe-core 4.13 gives radiogroup no requiredOwned, so a radiogroup may wrap a whole card (header p, dl, columns) around its radios without an aria-required-children failure
metadata:
  type: reference
---

axe-core (4.13 in apps/web) defines `radiogroup` with no `requiredOwned` in its
main standards table, so `aria-required-children` does not flag a radiogroup
whose subtree holds non-radio content (a card header `<p>`, a `<dl>` of the
answer each radio keeps). ChecklistConflictStep (NEO-478) uses this: each
`<li>` stays plain and its inner `<div role="radiogroup" aria-required>` wraps
the whole card, so the group name ("Disagreement on #60") scopes the two radios
for E2E and screen readers alike.

**How to apply:** when a choice's context must sit beside its radio, wrap the
card in the radiogroup rather than nesting a `group` and a `radiogroup` with the
same name. Re-check if axe is bumped (`grep -n "radiogroup: {" -A6
node_modules/axe-core/axe.js`). Never put `role` on the `<li>` itself — that
breaks the list's `listitem` children. See [[interactive-controls-carry-no-dom-id]].
