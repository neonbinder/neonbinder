---
name: sl-review-filter-is-substring
description: The SportLots review dialog's "Find a SportLots set" filter matches ANYWHERE in a label, so a row a flow filters to must be the first row of every label CONTAINING it, not just of its own prefix family
metadata:
  type: reference
---

`SlSetReviewModal` filters with `label.toLowerCase().includes(q)` and shows
rows in `routeSlSets`' folded-label order. "INSERT_ROW is the first row its
own filter shows" is therefore a claim about every label that contains the
text, anywhere.

Bowman shows why. In 2025 `Prospects` was first under its own filter. In
2022 and 2023, 15 `Best Top Prospects …` rows (Bowman's Best) sort above
it, so the tick would land about 16 rows down the dialog body. 2023 uses
`Prospect Autos` instead, which nothing else contains. When moving a
review flow to another year, re-derive both filter rows from the measured
list. A grep over the labels is enough: `grep -i '<row>' rows.txt | head -1`
must print the row itself.

Measuring a year's review read-only (SportLots list + BSC year sets through
`routeSlSets`) is described in the marketplace-adapter-dev note
[[read-only-marketplace-measurement]]. Calibrate the script on a year whose
count is already recorded before trusting a new one.

Related: [[splitting-a-flow-over-shared-real-data]].
