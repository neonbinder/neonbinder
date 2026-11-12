---
name: publisher-checklist-is-a-match-cards-source
description: Jason ruling (NEO-490, 2026-11-11) — an uploaded publisher's checklist is another SOURCE paired in the existing Match Cards dialog (CardPairingModal), not a sibling dialog; unmatched checklist rows may be discarded, marketplace cards never silently
metadata:
  type: project
---
Jason, 2026-11-11: "discarding rows is perfectly acceptable. Checklist should
be treated as another source that should be matched." Leftover checklist rows
and leftover cards are paired in CardPairingModal as a third column (two
marketplaces) or a second one (one marketplace, where the modal otherwise
skips). Only leftovers are shown.

**Why:** one matching vocabulary for every source; a second dialog was
rejected.

**How to apply:** checklist rows carry no marketplace ref, so they are
discardable and never affect `platformData`. Marketplace cards keep the
existing keep-shelf rules, except one-marketplace mode, where every
marketplace card is kept with no control to un-keep it (rule 5: a lost
marketplace link is a bug). A checklist link onto an unmatched marketplace
card also keeps that card. Related: [[checklist-pairing-modal-absorbs-only-teams]].
