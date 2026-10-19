---
name: reference-sl-set-has-no-product-id
description: SportLots' insert-level set list is flat id+label for the whole brand-year; a label auto-match can pair two products. Confirm a name-only pair by the pair preview's cards; the SL review is only a sometimes-present extra signal
metadata:
  type: reference
---

SportLots' `dealsets` list (convex/adapters/sportlots.ts `fetchSetNames`) holds every set of the brand-year as `{ value, platformValue }` only. It carries no product or parent id. The server's `computeMatches` auto-matches BSC to SL by label. That can pair Topps Chrome's "1988 Topps Baseball Autographs Red" with the flagship's "1988 Topps Autos Red".

Evidence for "whose SL set is this", strongest first:
- **Cards (always available).** Preview the pair with both ids (`previewCardChecklist`). Shared numbers are the `matched` entries with confidence 1. A shared number whose rosters disagree carries `playersConflict`. Code: `tools/setbuild/lib/pair-evidence.ts`. It needs at least one shared number, with at most 1/3 of them naming different players.
- **Another NB set of the brand holds it:** `setParallelConversion.getBrandSlHolders`.
- **The brand's SportLots review still holds it:** `slSetReview.getSlSetReview` entries. Often there is NO review document at all; a NEO-339 preview had zero. Never make a guard depend on the review existing.

Don't use `defaultSlPrefixes` / `inSlPrefixScope` for this. It is a label filter, and coordinators have ruled out label text for deciding product membership.

The UI's ReconciliationModal still puts such an auto-match in Ready. Only the set-build draft confirms by cards.

How to apply: treat any SL auto-match or "candidate" as name-only until its cards or an NB holder confirm it. See [[external-ids-must-be-verified-live]].
