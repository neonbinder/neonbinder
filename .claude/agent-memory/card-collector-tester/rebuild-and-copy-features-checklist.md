---
name: rebuild-and-copy-features-checklist
description: Collector tests for any feature that copies or rebuilds card rows (parallel builds, re-syncs) — SKU churn, hand-edit loss, per-card vs per-parallel facts, printing plates, unlinked parallels
metadata:
  type: feedback
---

When a feature copies cards from one NB row to another, or deletes and re-creates cards ("rebuild"), run these checks from the dealer's seat:

1. **SKU churn.** New rows get new SKUs (the SKU carries a random suffix). A dealer with printed labels or listed stock sees every SKU change. Ask whether the replacement can keep the old row's SKU when it maps to the same source card.
2. **Hand edits.** A rebuild throws away per-card operator edits (listing title, features, print run, Signed By) even when only scans block it. The confirm has to say so. An automatic rebuild with no confirm is the finding.
3. **Where each fact lives.** Print run and "autographed" are usually PARALLEL facts ("Gold /50", "Gold Auto"). Rookie, SP and variation are CARD facts. A copy must take parallel facts from the parallel row and card facts from the source card. If a fact comes from only one marketplace (for example, one side's checklist carries no print run), the other side's cards lose it silently.
4. **Several marketplace cards per number.** Printing plates are four 1/1s per card (C/M/Y/K), and some parallels come in retail and hobby versions. An exactly-one guard fails closed on all of them, so the parallel builds empty.
5. **No marketplace ids.** A parallel that no marketplace lists yet (a new release) still needs the insert's checklist. "Skip it" keys behaviour on having ids (invariant 6).
6. **Counts without names aren't actionable.** "3 left off" has to say which 3.

**Why:** In the NEO-312 review (2026-09-28), all six held for the parallel build.
**How to apply:** Use this for any plan that says copy, clone, rebuild or re-create for card rows. Related: [[neo-203-content-diff-review-spec]], [[marketplace_data_trust_characteristics]].
