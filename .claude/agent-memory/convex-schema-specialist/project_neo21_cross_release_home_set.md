---
name: project-neo21-cross-release-home-set
description: NEO-21 cross-release cards — cardChecklist.selectorOptionId is the immutable "home"/printed-in pointer; guest appearances go in the cardCrossListings junction table
metadata:
  type: project
---

NEO-21 (backend landed 2026-07-26 on `neonbinder/neo-21-set-builder-cross-release-home-set-for-cards-released-in`) added `cardCrossListings`, a junction table letting one `cardChecklist` row appear under a second variant-level `selectorOptions` node.

**The load-bearing invariant: `cardChecklist.selectorOptionId` always points at where the card was PHYSICALLY PRINTED, never at a guest checklist it merely completes.** Release year, `convex/sku.ts` SKU generation, and all provenance resolve by walking that pointer's ancestor chain. Real case: 2021 Score Football #301-320 shipped inside 2022 Chronicles packs — home = 2022 Chronicles, guest = 2021 Score.

**Why:** attributing pricing/provenance to the logical checklist instead of the physical product would silently corrupt every derived field. That's why the fix is purely additive display metadata rather than a repointed or nullable home pointer.

**How to apply:** any future schema work touching cards must not repoint, duplicate, or make optional `cardChecklist.selectorOptionId`, and must not "fix" `deriveCardFeatures.ts` / SKU to be cross-listing-aware — they are correct as-is by design. If a query needs "everything in this checklist", it now needs the home rows PLUS a `cardCrossListings` `by_selector_option` lookup; the merged list must be sorted with `compareCardNumbers`, not `sortOrder` (a guest row's sortOrder was stamped against its home set).

Operator workflow the backend was shaped around: open the GUEST checklist, point at the HOME set, supply card numbers that already exist there — the mutation links existing rows, it never creates card data.
