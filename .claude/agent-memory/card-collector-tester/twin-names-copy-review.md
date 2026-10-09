---
name: twin-names-copy-review
description: Patterns for reviewing copy about same-named marketplace sets (twins) and fix-it notices: verb must match the control, a bare id is not a tell, offer the hobby's own disambiguator as a hint never a prefill
metadata:
  type: feedback
---

When a marketplace lists two sets under one name (NEO-325 "twins"), review the copy with three tests:

1. **Fix verbs match the control labels.** If the button says Attach more… / Detach, the notice says attach/detach, not "link", "move", "take it off" or "put them on". A dealer scans for the word on the button.
2. **An id alone is not a tell.** `(#299607)` keeps rows distinct but gives the operator nothing to choose by. Ask for a content clue next to it (card count, number range or prefix, a couple of player names), fetched by the id on demand.
3. **Offer the hobby's disambiguator as a hint, never a prefill.** Dealers split flagship twins by release ("Series 1", "Series 2", "Update"). A placeholder/tip is fine; auto-naming would be NB guessing, which the invariant forbids.

**Why:** the operator has to act on these notices mid-build; a fix line naming a non-existent control or a choice with no evidence stalls the build or gets the pairing wrong (wrong set = wrong listing).
**How to apply:** any reconcile/hold/refusal notice in the set builder. Related: [[multi_landing_dialog_copy_follows_the_landing]], [[rebuild-and-copy-features-checklist]].
