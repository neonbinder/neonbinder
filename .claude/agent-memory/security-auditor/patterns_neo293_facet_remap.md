---
name: patterns-neo293-facet-remap
description: NEO-293 — bscSourceView is the single partition (sources / scope.own / untagged) that decides which BSC ids the Attach dialog may re-tag; attachPlatformIds refreshes the facet on an existing slot, so "already attached" filtering IS the re-tag guard; armed backfills in this repo do not validate their scope arg
metadata:
  type: project
---

Rule: any change that lets an already-attached BSC id back into AttachSetsDialog
is a facet-rewrite surface, because `allocateSlots` refreshes the facet on the
existing slot whenever the caller supplies one. The only client-side guard is
the `alreadyAttached` set, and after NEO-293 it is built from
`bscSourceView(row, chain)` (sources + scope.own), NOT from every slot. The
`untagged` bucket is the one that is offered for re-map. Audit steps:

1. Confirm the three buckets still partition every BSC slot (one `for` over
   `slotEntries`, each slot lands in exactly one list). A new bucket that is in
   neither `alreadyAttached` nor `needsRemap` silently becomes re-taggable.
2. The dialog sends only `setName` (sets rung) and `variantName` (variants
   rung); it never sends `variant`. Server side `attachPlatformIds` refuses
   `variant` on non-variantType rows but has NO reverse refusal (a
   `variantName` tag on a variantType row is accepted) — pre-existing, admin
   only.
3. Slot keys are `s<n>` / `b<n>` style, not marketplace ids, so returning slot
   keys from an internal report is not a marketplace-ref exposure.

**Why:** the untagged bucket was previously unreachable (filtered as attached),
so nothing could fix a stranded slot; opening it is correct but it is the same
lever that could re-scope a checklist if the partition ever leaked `own`.

**How to apply:** on any diff touching MultiSourcePanel.alreadyAttached,
bscSourceView, or CandidateRow `attached`, re-check the partition and re-run the
"variant SCOPE slot stays excluded" test. Also: the house armed-backfill
pattern (three files now) never validates its optional scope id's level — a
wrong id yields "scanned 0" that reads like a clean steady state; harmless but
note it each time rather than re-deriving.
