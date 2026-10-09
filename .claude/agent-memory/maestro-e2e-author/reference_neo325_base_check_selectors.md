---
name: neo325-base-check-selectors
description: Parallel Reconcile's Base check (NEO-325) — toggle accessible names, the row wrapper + reason line and sr-only status that a containsChild/containsDescendants pair scopes to ONE row, where it runs (parallel role + Base cards only), and what it does to Keep all and column counts
metadata:
  type: reference
---

**Where it runs.** `ReconciliationModal` gets `baseCheck` only from
`VariantForm` for a variant type whose NB role is `parallel`, and the check
switches itself off unless `getBaseSignatureForVariantType` answers `ok`
(Base has saved cards). Inserts, ParallelForm and a Base with no cards show
no chrome at all. It judges PENDING rows only: Ready, and so a reconcile's
Save, is untouched.

**Handles** (copy in `lib/cards/base-match.ts` `BASE_MATCH_COPY`; straight
apostrophes, match with `.`):
- toggle, per column: `Show N that don't match the Base, SportLots` /
  `Hide N …, BSC` (aria-label = visible words + `, <side>`). It renders under
  the column's checkboxes only while the column's QUERIED view holds a
  mismatch; its open/closed state survives the query changing.
- revealed rows render FIRST (above the matched/checking rows), each in a
  wrapper `<div>` whose direct children are the row and its reason `<p>`
  (`Doesn't match the Base — <observed> (Base: <expected>)`, or `Couldn't
  check against the Base — …` for an unverifiable row, which stays listed).
- every row's handle holds an sr-only span `, matches the Base` / `,
  doesn't match the Base` / `, checking against the Base` / `, couldn't be
  checked against the Base` (a 1×1 node maestro-web lists).
- column counter `Checking against Base — X of Y` → `Checked against Base —
  A match, B don't[, C couldn't be checked]` + an aria-hidden sleeve strip
  (≤200 sleeves, ~33 per 463px row) above the search box.

**One row, one node:** `containsChild` is direct-children-only, so
`{containsChild: {text: "Doesn.t match the Base.*"}, containsDescendants:
[{id: "Make its own set: <label>"}]}` resolves to exactly that row's wrapper,
and `{containsChild: {text: ".*matches the Base"}, containsDescendants:
[{text: "\\(#<id>\\)"}]}` to that row's handle. Verified by javap (2.8.0):
`Filters.containsChild` runs the child filter over the whole node list (no
visibility), and `ElementSelector.evaluateScripts` recurses into
`containsChild`/`containsDescendants`, so `${output.X}` works inside them.

**Side effects on other selectors:** `<Side> (N of M)` counts only the
listed rows (set-aside rows leave N); `Keep all: N <side> sets` counts only
rows already CHECKED and not set aside, so a Keep all pressed while the
check runs promotes fewer rows. A probe that fails is `unverifiable`, never
set aside.

Related: [[guard-a-tap-at-a-footer-buttons-x]],
[[sportlots-twin-names-and-public-search]], [[touch-swipe-scrolls-a-dialog-body]].
