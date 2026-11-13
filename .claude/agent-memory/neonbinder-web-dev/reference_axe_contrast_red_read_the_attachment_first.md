---
name: axe-contrast-red-read-the-attachment-first
description: A CI axe color-contrast red names only the first selector; the blob report's "axe <label>" attachment holds every node's measured fg/bg, and a token blended toward the bg means a mid-animation frame, not a bad colour role
metadata:
  type: reference
---

The failure line (`4 elements; first: .bg-field\/60`) is all the log shows. The full
per-node result (fg, bg, ratio) is in the run's `pw-report-<project>-<n>` artifact:
unzip `report/blob/*.zip`, find the attachment named `axe <label> (<project>)` in
`report.jsonl` (field `base64`), decode, read `modes.<mode>.violations[].nodes[].failureSummary`.

**Read it before touching a token.** If every failing fg is the role's colour mixed
toward the lane/row background by the same fraction (NEO-529: ink-3, ink-2 and the
pink Set aside text all at ~43%), the nodes share one ancestor caught mid-fade
(`intake-arrive`, opacity from 0). The settled roles passed at 7:1+, so a solid
background or a new ink role would have changed the look and fixed nothing.

Cause: `settle()` in `playwright/support/a11y.ts` only proves the screen was still
when axe *began*; a Convex push that moves a tile to another lane remounts its `<li>`
and replays the arrive animation while axe runs. Desktop passed, mobile failed: pure race.
Fix lives in the harness (red pass + motion started during it → settle and re-run,
bounded), not the product. See [[no-product-changes-to-satisfy-a-test]].
