---
name: id-less-items-in-stores-and-commits
description: How the selector stores and the card commit treat items/cards with no marketplace id — a plain identityOnly id-less item is withheld noIdToAttach; checklist lines are found by their linked sections; ref-less no-number cards re-match by number + folded name
metadata:
  type: reference
---

Anything that writes NB rows or cards without a marketplace id (publisher
checklists, hand-made sets) needs an identity both the first write and the
re-sync can match on. What exists (NEO-496):

- **Selector stores (`planSelectorSync`).** An id-less item with no namesake
  inserts; with one namesake it is withheld `noIdToAttach`. An id-less
  `identityOnly` item is withheld `noIdToAttach` UNLESS the store marked it
  `checklistOnly` (it carries `checklistSectionKeys`): then it inserts, or is
  withheld `nameTakenBySibling` / `nameSharedInBatch`. Before the planner,
  `storeReconciledOptions` routes an id-less line carrying sections to the ONE
  sibling already linking one of them (`existingId`), so a replay or a
  re-sync lands on the same row even after a rename; held by more than one
  row (or by a row under another type) it is a `presetWithhold`
  (`checklistKeyHeldByMany`). `withheldSiblings` lists id-less items only when
  they carry sections. A replayed page (NEO-296) re-sends rows the first page
  inserted, so any new id-less identity needs that kind of idempotent match.
- **Card commit (`buildMatchMaps` / `resolveExistingIds`).** A card with no
  ref on either side matches a stored ref-less card by its exact
  `cardNumber`, exactly-one on both sides; a NO-number card ("NNO"/blank) by
  number plus `normalizeEntityName(cardName)` (`noRefMatchKey`), still
  exactly-one, so two same-name NNO cards stay "new" rather than guess.

**How to apply:** when a feature adds another id-less identity, add an
explicit branch in BOTH store loops ([[store-loops-fall-through-to-insert]])
and a report entry, and test the replay and the re-sync, not only the first
write.
