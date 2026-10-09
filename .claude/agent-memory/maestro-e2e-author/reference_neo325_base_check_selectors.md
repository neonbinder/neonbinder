---
name: neo325-base-check-selectors
description: Parallel Reconcile's Base check (NEO-325) — the constant toggle name (open/closed proved by the revealed row), Keep all's names, the row wrapper + reason line a containsChild/containsDescendants pair scopes to ONE row, per-id verdicts via sleeve titles (the sr-only status is unreachable), where it runs (parallel role + Base cards only), and what it does to Keep all and column counts
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
- toggle, per column: a disclosure named `N that don't match the Base,
  SportLots` / `…, BSC` (visible text `N that don't match the Base` + `,
  <side>`). The name is the SAME open or closed — the state is
  `aria-expanded` only, which maestro-web cannot read — so prove OPEN by a
  revealed row's reason visible and CLOSED by it gone (positives after the
  negative). Selector: `[0-9]+ that don.t match the Base, SportLots`. It
  renders under the column's checkboxes only while the column's QUERIED view
  holds a mismatch; its open/closed state survives the query changing.
- revealed rows render FIRST (above the matched/checking rows), each in a
  wrapper `<div>` whose direct children are the row and its reason `<p>`
  (`Doesn't match the Base — <observed> (Base: <expected>)`, or `Couldn't
  check this one against the Base. Try again later.` / `…: no card to
  compare.` / `…: sign in, then reopen this.` for an unverifiable row, which
  stays LISTED, never in the revealed group). So a bare
  `containsChild: {text: "Doesn.t match the Base.*"}` names only revealed rows.
- every row's handle holds an sr-only span `, matches the Base` / `, doesn't
  match the Base` / … — UNUSABLE: the body scroller is unpositioned, so the
  span stays at its scrollTop-0 spot and is pruned once the body is lifted
  ([[sr-only-in-unpositioned-scroller]]; CI-proved). Per-id verdict instead:
  the sleeve strip's `title` → `id: "<label> — Matches the Base"` (or `<label>
  — <reason>`; `— checking against the Base` while pending). The strip draws
  the scope's first 200 sets only (`+N`). The verdict glyph is an svg, which
  maestro-web never lists.
- column counter `Checking against Base — X of Y` → `Checked against Base —
  A match, B don't[, C couldn't be checked]` + an aria-hidden sleeve strip
  (≤200 sleeves, ~33 per 463px row) above the search box.

**One row, one node:** `containsChild` is direct-children-only, so
`{containsChild: {text: "Doesn.t match the Base.*"}, containsDescendants:
[{id: "Make its own set: <label>"}]}` resolves to exactly that row's wrapper (the `.*matches the Base` handle
form is dead, above). Verified by javap (2.8.0):
`Filters.containsChild` runs the child filter over the whole node list (no
visibility), and `ElementSelector.evaluateScripts` recurses into
`containsChild`/`containsDescendants`, so `${output.X}` works inside them.

**Side effects on other selectors:** `<Side> (N of M)` counts only the
listed rows (set-aside rows leave N). Keep all's name is `Keep all, <side>
sets` when it reaches the whole column (NO count) and `Keep all N, <side>
set(s)` when a filter, the SL prefix filter or the check narrows it; with 0
reachable it drops the number (aria-disabled). It reaches only rows already
CHECKED and not set aside, so a Keep all pressed while the check runs
promotes fewer rows. Unfiltered, read the count off `<Side> (N)` and prove it
by the Ready arithmetic, not the button name. A probe that fails is `unverifiable`, never
set aside.

Related: [[guard-a-tap-at-a-footer-buttons-x]],
[[sportlots-twin-names-and-public-search]], [[touch-swipe-scrolls-a-dialog-body]].
