---
name: reference-neo527-paused-mint-and-title-fixture
description: Simulating a marketplace pause in convex-test (PAUSED_PLATFORMS_ENV stub), proving "resume links onto NB's row", and a copy-features-down fixture that lets a parent row's feature leak reach a card's stored title
metadata:
  type: reference
---

**Pause in a test.** `vi.stubEnv(PAUSED_PLATFORMS_ENV, "sportlots")` (import from `convex/lib/marketplacePause`) makes `resolvableSides(..., { paused: pausedSides() })` drop the side. Give the sport/year chain real SportLots ids so the pause is the ONLY reason a minted row has no SL slot. Otherwise a "no slot" assertion passes for the wrong reason. Assert that precondition inside the mint helper. It is also what catches a break that ignores the pause.

**Resume linkage.** Mint with the pause stubbed (`t.run(ctx => ensureBrandRowForName(ctx, ...))`), unstub, then `storeSelectorOptions` at the manufacturer level with `coveredSides` + `returnedIds` including `SL_ALL_BRANDS_BRAND_ID`. Check: one row, `Object.values(platformData.sportlots)` equals `[id]`, and value and prefix are unchanged. Use `test.each` for NB's spelling and the marketplace's capitals. Break-check: `if (!slot) return false` in `isSideFreeForNameMatch`.

**Title fixtures.** Hand-written `features` on set/variant rows hide feature leaks from the ancestor rows. Copy `{ ...parent.features }` down when you seed children, as creation does. Then a leak (e.g. the Unknown row keeping `features.manufacturer`) reaches the card and shows up as "2026 Unknown Topps Chrome". The full `commitCardChecklist` action runs offline with SportLots-only cards (`platformData: { sportlots: { ref } }`). Run `drainScheduled` and then `cancelScheduled` after it.

**Dry-run writes nothing.** Comparing `toEqual` snapshots of the whole `selectorOptions` table before and after the run also catches `lastUpdated` bumps. See [[reference-neo322-rekey-arm-test-pattern]].
