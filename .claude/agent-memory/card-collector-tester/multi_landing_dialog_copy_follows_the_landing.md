---
name: multi-landing-dialog-copy-follows-the-landing
description: Copy-review checks for set-shape dialogs (Make parallel/insert of, Promote, SL review): title/confirm/aria must follow the chosen landing; "its link moves" must be conditional; count labels must name what is counted
metadata:
  type: project
---

Recurring copy defects found reviewing NEO-306 set-shape dialogs (2026-09-25):

- A dialog with several landings (new insert, join insert, new/join parallel of an insert) tends to keep ONE title/confirm ("Make it an insert") even when the preview lands a parallel. Check title, confirm and toast against every landing.
- Per-choice aria labels get copy-pasted from the parent level ("Parallel of {parallel}" on a parallel choice). Read each aria-label with a real value in it.
- Source eligibility for these doors does not always require a marketplace link (a hand-made set with no ids is eligible), so "Its SportLots link moves over" must be conditional on a link count the server returns.
- Count labels on attention buttons: check WHAT is counted ("Fill 5 missing teams" counted cards, not teams).
- Zero-card branches of pluralised sentences break verb agreement ("Its SportLots set become…"); read the n=0 and loading-fallback renders.

**Why:** these are the misreads a dealer processing hundreds of rows hits first, and none is caught by tests that assert the constant.
**How to apply:** on any copy review of a dialog built from `SetShapeDialog`/`ChoiceList`, render each string with n=0, n=1, n>1 and every landing kind before judging it. Related: [[neo239_retire_custom_concept_test]].
