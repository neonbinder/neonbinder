---
name: neo306-sl-review-and-insert-door
description: NEO-306 surfaces — the Sets column's "N SportLots sets to sort" review (picker names lead with their visible choice), Make insert of…'s landing-dependent title/confirm/path toast, the checklist's "N cards need a team" — plus the trap that a POPULATED insert column never auto-reconciles
metadata:
  type: reference
---

**Sync Sets no longer mints SportLots-only sets.** Each such name waits in a
per-BRAND review doc; the amber pill `N SportLots sets to sort` (or `N
SportLots sets left — save again`) sits in a brand's Sets-column idle row
beside `Sync Sets`. Never on the All Brands view (it spans brands). Paused
SportLots → no review, no pill. A flow that needs an SL-only set must save a
review first.

Review dialog (`SlSetReviewModal`, fixed portal; header + footer pinned, rows
in the body scroller):
* filter `Find a SportLots set` (explicit aria-label → `id:` works);
  `Select all shown` (header tick); per-row `Select <label>`.
* Every picker's accessible name STARTS with its visible choice (SC 2.5.3):
  bulk `<choice>: set the selected rows belong to` (list `Sets the selected
  rows can belong to`), `<choice>: where the selected rows are filed` (list
  `Types under <set>`); per row `<choice>: set <label> belongs to` (list
  `Where <label> goes`, first option `Its own set`), `<choice>: where <label>
  is filed`. So the name doubles as a read-back of the row's decision.
* Picking a set force-syncs its Variant Types (marketplace round-trip); busy
  line `Syncing <set>'s variant types…`, type trigger `inert` until it lands.
* `Apply to N selected` (0 after an apply), footer `Save will file: 1 set · N
  parallels · M inserts` (no period), `Save N SportLots sets`; column toast
  `Saved 1 set, N parallels, M inserts.` (+ ` K skipped: …`).
* Rows sorted by folded label: a filter puts the shortest match first, so its
  inline list opens at the top of the body.

**A populated insert/parallel column never auto-reconciles.** `EntityColumn`'s
legacy auto-sync fires only on an EMPTY column; once the review files rows
under Bowman › Parallel/Insert, opening that type shows an idle list and the
flow must tap `Sync <Type>s`. Two flows that both need a "first cold open"
of the same variant type can never be ordered by the CI queue — the owner's
fix (2026-09-25) was ONE ordered flow per real brand-year.

Make insert of…: title/confirm follow the landing — `Make “X” an insert` /
`Make “X” a parallel`; confirm `Make it an insert` / `Make it a parallel` /
`Add it to <row>`; choices `Insert of <set>`, `Add to <insert>`, `New insert:
<name>`, `New insert named…`, `New parallel: <name>`, `Add to <parallel>`;
toast `“X” now lives at <set> › <type> › <insert>[ › <parallel>].` / `“X”
joined …`. Choice lists are max-h-40 inner scrollers with a filter (`Find a set` /
`Find an insert` / `Find a parallel`) only above 12 choices — use it when
it is there (`runFlow when: visible` on the filter resolves at once when
present), then assert the radio.

Fill teams: checklist header, amber, `1 card needs a team` / `N cards need a
team`, only while N > 0; result in the checklist's own notice line.

Worked example: `flagship-colour-is-a-parallel-both-ways.yaml` (all of 2026 Bowman, in order). Selector
mechanics: [[childof-parent-is-first-match]].
