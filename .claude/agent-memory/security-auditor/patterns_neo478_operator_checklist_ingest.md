---
name: patterns-neo478-operator-checklist-ingest
description: Operator-pasted/uploaded text parsed in the browser and re-checked on an admin action — where the bounds live, the quadratic whitespace-split trap, and the uncapped pair-list in the matcher
metadata:
  type: feedback
---

Shape that held (PR 451 / NEO-478 publisher checklist): parse in the browser
(file size cap, row cap, per-name cap), send rows as an optional arg on an
already-requireAdmin action, re-check every limit server-side AFTER the gate
(refuse whole, error names row position only, never the text), log counts
only, never store the rows (conflicts ride the transient candidate rows,
bounded by the same per-card caps).

Checks to repeat on any "operator pastes a file" feature:
- **Run the split/line regexes on an adversarial line.** `/\s+[-–—]\s+/`
  is quadratic on a long whitespace run (100k spaces = ~7 s in node); a 2 MB
  file cap still allows a single 2 MB line. Fix: collapse whitespace first,
  or literal single spaces. Browser-only = self-DoS (note), server-side = real.
- **Pair lists in the matcher** (e.g. "misreads": every unmatched card x every
  row with the same name key) are cards x rows in the worst case; cap them
  when the server only needs a count.
- **A server-side cap on a derived list** (unique comma team texts) that is
  smaller than rows x per-row cap turns an honest big upload into a generic
  fetch failure; check the error reaches the operator in words.
- CSV formula injection matters only if something EXPORTS to a spreadsheet;
  grep for `text/csv` / Blob downloads before raising it.
- A client-supplied "answered by X" outcome literal that permanently
  suppresses a re-ask is admin-forgeable on commit; same class as
  [[patterns_attention_flag_suppression]].
