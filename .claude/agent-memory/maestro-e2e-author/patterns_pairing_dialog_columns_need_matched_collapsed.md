---
name: pairing-dialog-columns-need-matched-collapsed
description: CardPairingModal's BSC-only / SportLots-only columns sit BELOW the Matched list in the body scroller; Matched starts collapsed only if the FIRST streamed batch had an unmatched card, so collapse it (id "Collapse matched cards.*") before asserting or tapping Keep all
metadata:
  type: reference
---

The Match Cards dialog body (`overflow-y-auto`, undrivable by maestro-web)
renders Matched first, then the `BSC only (N)` / `SportLots only (N)` columns
with `Keep all BSC-only cards` / `Keep all SportLots-only cards`.
`matchedCollapsed` is `useState(initialData.unmatched* > 0)` — evaluated ONCE
at mount, and the dialog mounts on the first streamed candidates (NEO-195). So
whether the columns start near the body's top depends on stream order.

**How to apply:** after the `^Confirm$` fetch-done gate,
`runFlow when visible id "Collapse matched cards.*"` → tap it, then hard-wait
`id: "Expand matched cards.*"` (the toggle's aria-label flips; it is sticky at
the body top so always on screen). Only then hard-assert the column headings.
The retired seed's `when: visible "BSC only (…)"` guards could skip Keep all
silently for exactly this reason.

Prove Keep all by arithmetic, not by sight: `copyTextFrom` both column
headings and the footer `N cards will be saved` before, then after the keeps
`assertTrue` footer == before + bsc + sl (footer = matched + kept).
Worked example: `topps-chrome-insert-keep-all-no-wizard.yaml`.
Related: [[pairing-sync-test]] (any flow mentioning "Match Cards" needs
`^Confirm$` or a `maestro-lint: streaming-ok` reason).
