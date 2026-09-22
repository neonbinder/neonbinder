---
name: reference-neo237-all-brands-view-second-pass
description: NEO-237 second unit-test pass — file layout for ensureBrandUnknownRow/rehomeSetRowsForSync (the setCandidates reconcile tests went with the table the same day), the resolvableSides chain-shape trap for SL-attach tests, and the EntitySelector/EntityColumn pinned-view test recipes
metadata:
  type: reference
---

Second-pass coverage for NEO-237 (All Brands view / Unknown bucket / brand
routing via SportLots' All Brands). First pass already covered the pure
matchers (`routeBscSets`/`routeSlSets`/`matchesBrandPrefix` in
`selectorBrandRouting.test.ts`) and the DB-mutation halves of
`brandRehome.ts`. This pass filled the DB-writing mutations those pure
helpers feed, plus the component layer.

## New files (convex)
- `ensureBrandUnknownRow.test.ts` — dedicated mint/adopt tests for the
  internal mutation (found by `metadata.isBrandUnknown` flag, never by name;
  features copied minus `manufacturer`; SL slot attached only if none present;
  throws on an unflagged sibling literally named "Unknown").
- `reconcileSetCandidates.test.ts` — WRITTEN AND DELETED THE SAME DAY
  (2026-09-21) with the `setCandidates` table and its review modal, once
  Jason ruled a set a marketplace lists is saved, not offered. Its
  replacements are `createSetsFromSlRoots.test.ts` (the internal mutation
  that mints the set + Base per SportLots root, chunked, one year index per
  call) and `setFromMarketplace.test.ts` (the helper, both read paths). The
  recipe it used — upsert keeps status, write-if-changed, unseen rows
  deleted, bounds re-asserted at the write door — is still the shape for
  any reconcile-style writer.
- Extended `brandRehome.test.ts` with a `rehomeSetRowsForSync` describe block
  — the internal mutation `routeBscSets`'s moves feed, distinct from the pure
  `rehomeSetRowsToBrand`/`rehomeSetsFromBrandUnknown` already there. Key
  behavior: re-checks the row's CURRENT parent still carries
  `metadata.isBrandUnknown === true` before moving (a row an operator or
  concurrent request already moved elsewhere in the meantime is left alone).
- `fetchAggregatedOptions.allBrandsRouting.test.ts` — manufacturer-level
  `fetchAggregatedOptions` against a REAL stubbed SL `newinven.tpl` fetch
  (the `platformLevelSupport.test.ts` harness, not a mocked adapter module)
  with an "All Brands" option in the brand HTML: mints Unknown carrying the
  sentinel + flag, never stores a row named "All Brands", and the NEO-211
  unlink pass keeps every holder (Unknown AND a pre-existing via-All-Brands
  brand) because the sentinel id is still in `returnedIds.sportlots`.
- `selectorSyncSuggestions.slAllBrands.test.ts` — D7 suppression: a
  manufacturer row whose primary SL slot is the sentinel never offers or
  accepts a rename suggestion (`getSelectorSyncSuggestions` returns `[]`;
  `applySelectorSyncSuggestions` counts the decision as `skipped`).
- `ensureSelectorOptions.setNameYearParent.test.ts` — the setName dispatch
  from the All Brands VIEW (parent = year, not manufacturer): "populated"
  reads `yearHasAnySet`; the sync runs WITHOUT `manufacturerId` and covers
  every brand under the year; the SL attach-rule gate at setName uses
  sport+year (not the deeper `SL_ATTACH_REQUIRED_LEVELS`) so a year with SL
  ids and no BSC id still reaches the action; an SL skip at setName is
  NOTIFIABLE (D14b — the served-level table would normally file it as
  structural, but the set sync's own `skippedSides` is authoritative there).
- `setReconciliation.brandScope.test.ts` — `fetchRawOptions` and
  `fetchSlAttachSets`/`resolveAttachContext` pass the manufacturer ancestor's
  `metadata.setNamePrefix` as `brandScope` UNCONDITIONALLY (both a
  via-All-Brands brand and a real-brand Topps-style ancestor send it — the
  adapter is what ignores it for a real brand id). Mocked the SL adapter
  module (`vi.mock("./adapters/sportlots", ...)`) to capture call args
  directly rather than stubbing `fetch`, since the assertion is purely about
  what crosses the Convex→adapter boundary.
- `sportlots.fetchSetNames.brandScope.test.ts` — the adapter's own gate: only
  narrows/strips when `brd` (the resolved platformFilters value, not the
  brandScope arg) IS the sentinel; a real brand's `brd` is untouched even
  when a `brandScope` is passed; an empty prefix on an all-brands request is
  refused with `SL_UNSCOPED_MESSAGE`. At convex/ root, not convex/adapters/,
  per [[reference-convextest-modules-glob-must-be-convex-root]].

## The resolvableSides "unlinked set" trap for insert-level chain fixtures

Any test seeding a chain for `level: "insert"` (or another `SL_LINKED_SET_FETCH_LEVELS`
member) MUST include a `setName` row between manufacturer and variantType, and
either the setName row or something AT/BELOW it must carry a marketplace id.
Skip the setName row (going straight manufacturer→variantType) and
`resolvableSides` silently treats the WHOLE PATH as SL-unresolvable too (the
"unlinked set" rule: `setRowIndex === -1` → `missingSl.push("unlinked
set")`), so `skippedSides.length === 2` and the fetch never happens at all —
symptom is an empty `calls` array with no thrown error, easy to misdiagnose
as a mocking problem. Fixed in `setReconciliation.brandScope.test.ts` by
giving the leaf variantType row (standing in for Base) its own SL id.

## Component test recipes

- `EntitySelector.pinned.test.tsx` — the generic `pinnedEntries` contract:
  present with zero data rows, excluded from `showSearch` (`sortedItems.length
  > 8`, since pinned items are NOT in `sortedItems`) and the search filter,
  reachable by roving tabindex AND typeahead (both are computed over `rows =
  [...pinnedItems, ...filteredItems]`), `onSelect` fires with the raw
  sentinel string. No jest-dom matchers are configured in this project — use
  `.getAttribute(...)` / `not.toBeNull()`, never `toBeInTheDocument`/
  `toHaveAttribute` (confirmed: `Invalid Chai property` at runtime).
- `ManufacturerSelector.test.tsx` — first test file for this component ever;
  mock `convex/react`'s `useQuery` switched on the query-ref STRING (two
  different `useQuery` call sites in one component: the year lookup and
  EntitySelector's own list query) since both go through the same mocked
  hook.
- `SetSelector.allBrandsView.test.tsx` (components/modules) — reused the
  `SetSelector.liveRegion.test.tsx` all-children-stubbed pattern, extending
  `ResilientEntityColumn`'s stub to also expose `level`/`parentId`/
  `hideCustom` as data attributes so the module's OWN prop wiring (not
  EntityColumn's internals) is what's asserted: Sets column parentId flips to
  the year under the view, hideCustom reason line, `handleSetSelect(id,
  parentId)` back-fills the manufacturer, `deepestSelectedId` falls back to
  the year (never the sentinel string) when the view is selected with nothing
  beneath it.
- `EntityColumn.viaAllBrands.test.tsx` — reused
  `EntityColumn.custom-confirm.test.tsx`'s mock scaffold (`useMutation`/
  `useConvex().query`/`useQuery` all mocked, real component). The
  `offersViaAllBrands` gate needs `resolvableSides(chain, {level:
  "manufacturer"}).sportlots.resolvable`, i.e. `SL_SCOPE_BY_LEVEL.manufacturer
  = ["sport","year"]` — the sport AND year ancestor rows in the mocked chain
  both need `platformData.sportlots`. Also: after "Back to <level> name" the
  form returns to the INPUT stage (value still filled), not the idle "+
  Custom" button — resubmit via Enter on the still-mounted input rather than
  re-clicking "+ Custom" (it isn't rendered mid-form).

Full family: `apps/web/convex/{ensureBrandUnknownRow,
fetchAggregatedOptions.allBrandsRouting,selectorSyncSuggestions.slAllBrands,
ensureSelectorOptions.setNameYearParent,setReconciliation.brandScope,
sportlots.fetchSetNames.brandScope}.test.ts`, extended `brandRehome.test.ts`;
`apps/web/components/SetSelector/{EntitySelector.pinned,
ManufacturerSelector,EntityColumn.viaAllBrands}.test.tsx`,
`apps/web/components/modules/SetSelector.allBrandsView.test.tsx`. All green
first or second try; `npm run test:unit` 324/324 files, 7071/7071 tests
(baseline before this pass: 313 files / 6986 tests).
