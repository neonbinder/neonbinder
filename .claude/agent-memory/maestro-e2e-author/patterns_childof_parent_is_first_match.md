---
name: childof-parent-is-first-match
description: `childOf:` searches under the FIRST element its parent selector matches (Orchestra.resolveParentHierarchy → firstOrNull), so a disclosure trigger and its open list sharing one aria-label send the child search into the trigger; `index:` inside the parent selector picks by position
metadata:
  type: reference
---

Decompiled from the pinned CLI (2.8.0) `maestro.orchestra.Orchestra`:
`resolveParentHierarchy(selector, root)` builds the parent selector's filter,
runs it over `aggregate(root)` and takes **`firstOrNull`**; the child selector
then searches only that node's subtree. `buildFilter` honours every
`ElementSelector` key on the parent, including `index` — and `Filters.index`
**sorts by position** (`sortedWith` a bounds comparator) before `getOrNull`.

So:

* When a trigger button and the list it opens carry the SAME accessible name
  (a disclosure whose group is labelled like its button), `childOf: {id: X}`
  resolves to whichever sorts first in hierarchy order — the trigger — and a
  `text:` that only exists in the list is "not found".
  `childOf: {id: X, index: 1}` picks the list when it renders UNDER the
  trigger. Better still, ask for a distinct list name (NEO-306's review gave
  its bulk list `Sets the selected rows can belong to` for exactly this).
* `childOf` is the right tool when the same words sit behind a fixed dialog
  (a column row reading `Bowman` under the review's `Bowman` option): scope to
  the list's own aria-label and the page element can never win.
* A selector's `index:` is positional (top-then-left), not DOM order —
  `assertVisible: {id: "Remove Blue from Blue", index: 1}` is "a SECOND such
  control exists", a clean way to assert two same-named chips on one row.

Verify any new idiom with the offline parse harness
([[offline-flow-parse-harness]]); the parsed dump shows `childOf=ElementSelector(…, index=1)`.
Related: [[maestro-web-driver-primitives]], [[maestro-web-getnodetext-form-values]].
