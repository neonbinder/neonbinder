---
name: maestro-multi-select-unreachable
description: Maestro's web driver can only tap options in the FIRST native <select> on a page — never build a Maestro-covered view with more than one <select>; use button lists
metadata:
  type: reference
---

Maestro's web driver assigns every `<option>` synthetic tap bounds from its index
inside its own parent select only (`y = 100000 + idx * 20`), ignoring which
`<select>` it belongs to. Its tap resolver walks
`document.querySelectorAll('option')` and takes the first bounds match, so with
two or more `<select>`s on screen **only the first in document order is ever
reachable** — tapping an option meant for the second select silently mutates the
first.

**How to apply:** any view that E2E must drive gets clickable button/row lists,
not native `<select>`s (this is why `EntityColumn`/`ResilientEntityColumn` are
drivable and the original `<select>`-stack `CrossListingImportModal` was not —
rewritten as a one-level-at-a-time button wizard for NEO-21). A single `<select>`
alone on a page still works. Not fixable from the flow YAML side; confirmed by
disassembling the driver.

Related: Maestro can't scroll inside a `fixed` overlay (`scrollUntilVisible` is
just `window.scrollTo`), so modals must keep every control on screen at the CI
viewport (1024x629) — cap/flex the one scrollable list instead of letting the
modal body grow.
