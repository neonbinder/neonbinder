---
name: reference-generatelisting-wiring-integration-tests
description: How to integration-test generateListingTitle/Description wiring into addCustomCard/commitCardChecklist without duplicating generateListing.test.ts's own unit coverage; write-once no-overwrite fixture recipe.
metadata:
  type: reference
---

## Testing the WIRING, not the string composition again

`convex/features/generateListing.ts` (`generateListingTitle`/
`generateListingDescription`) is a pure module with its own full unit
coverage in `generateListing.test.ts`. When it gets wired into a mutation
(`addCustomCard`, `commitCardChecklist`'s insert branch — NEO-24/71-74),
don't re-test the string-composition logic (truncation, token ordering,
etc.) again at the integration layer — just prove the wiring: a real
insert produces a non-empty `listingTitle`/`listingDescription` containing
the card's actual resolved data (year/manufacturer/set/player/card#), and
that re-committing an existing row never overwrites an operator edit.

## Fixture recipe for commitCardChecklist listing-generation tests

`commitCardChecklist` reads listing inputs from three places:
1. The **leaf selectorOptions node's `features` map** (manufacturer,
   season, parallelName, etc.) — no ancestor walk, just that one row.
2. A **batch-level `setName` ancestor value**, fetched once via
   `findSetNameValue` (walks `parentId` up from the leaf to the nearest
   `level: "setName"` row) — used only for the `setName` listing input.
3. **Real resolved player names** (`card.playerIds` → looked up via
   `ctx.db.get` in the same mutation), NOT `pendingPlayerNames` — that's
   `addCustomCard`'s fallback since a custom card's players aren't
   resolved yet at add-time.

Minimal raw-insert fixture (mirrors the existing
`seedSubtree`/`per-card derived features` pattern in
`featurePropagation.test.ts`): sport → setName (value "Chrome", with
`features: { manufacturer: "Topps", season: "2024" }`) → variantType
(same `features` copied onto the leaf, since only the leaf is read). Don't
bother building the deeper year/manufacturer chain via the real
`addCustomSelectorOption` mutation unless the test also cares about
copy-down — a raw 3-row insert satisfies `commitCardChecklist`'s actual
read pattern.

## Write-once no-overwrite test shape

1. Commit once via `commitCardChecklist` (real mutation) → read the row →
   assert `listingTitle` truthy.
2. `updateCard({ id, listingTitle: "My Custom Operator Title" })` to
   simulate an operator edit.
3. Re-run the SAME `commitCardChecklist` call (identical `cardNumber`) →
   assert `listingTitle` is STILL `"My Custom Operator Title"`.

This works because `commitCardChecklist`'s existing-row `ctx.db.patch(...)`
branch (for a `cardNumber` that already exists) never includes
`listingTitle`/`listingDescription` in its patch object at all — only the
new-row insert branch generates them. Same "existing rows owned by the
propagation engine, never clobbered on re-sync" rule already established
for the `features` map (see
[[reference-setcardfeature-fixture-and-docstring-trust]]).

Established in NEO-71-74 while adding integration coverage to
`convex/cardFeatureDerivation.test.ts` (addCustomCard) and
`convex/featurePropagation.test.ts` (commitCardChecklist) — the item-5 task
explicitly named these as the right existing files to extend rather than
creating a new dedicated file, since it was only 1-3 test cases per
mutation (below the "6+ cases, orthogonal behavior" threshold for a new
file — see [[reference-setcardfeature-fixture-and-docstring-trust]]'s file
organization note).
