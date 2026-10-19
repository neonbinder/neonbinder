---
name: reference-sl-set-has-no-product-id
description: SportLots' insert-level set list is flat id+label for the whole brand-year; the only id evidence of which NB set owns an SL set is brand holders and the brand's SL review entries
metadata:
  type: reference
---

SportLots' `dealsets` list (convex/adapters/sportlots.ts `fetchSetNames`) is every set of the brand-year, `{ value, platformValue }` only. There is no product or parent id. The server's `computeMatches` auto-matches BSC and SL by label similarity, so a flagship SL set ("1988 Topps Autos Red") can be auto-matched into Topps Chrome's Reconcile Ready column.

The id/structure evidence for "whose SL set is this":
- another NB set of the brand holds it: `setParallelConversion.getBrandSlHolders`, which feeds `heldInBrand` in the seed.
- it still sits unsorted in the brand's SportLots review: `slSetReview.getSlSetReview(manufacturerId).entries[].slId`. Sync Sets' `routeSlSets` routes there any SL set it could not hide as covered or as a known set's variant. The tool's helper is `readUnsortedSlIds` in tools/setbuild/lib/reconcile-variants.ts (NEO-339).

The dialog's `defaultSlPrefixes` / `inSlPrefixScope` is a label filter. Coordinators have ruled that label text must not decide product membership, so use the two id signals above.

The UI's ReconciliationModal still puts such an auto-match in Ready. Only the set-build tool refuses to propose it.

How to apply: before trusting an SL auto-match, an SL "candidate" or a plan that says "match the SL set by name", check these two id sources. See [[external-ids-must-be-verified-live]].
