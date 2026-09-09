---
name: neo91_sku_and_sl_setradioid_wiring
description: Test recipes for generateSku (convex/sku.ts) pure-function edge cases, fetchSportLotsChecklist's setRadioId precedence fix, and commitCardChecklist/addCustomCard SKU insert-then-patch wiring (NEO-91)
metadata:
  type: reference
---

Three new convex/ root test files added for NEO-91 (all additive, no implementation changes needed — the shipped code was correct):

- `convex/sku.test.ts` — pure function, no convexTest needed.
- `convex/sportlots.test.ts` — first-ever dedicated sportlots adapter test file.
- `convex/skuWiring.test.ts` — commitCardChecklist/addCustomCard integration.

**generateSku (convex/sku.ts) length behavior — verified by reading the code, not assumed:**
Only `sportCode` (known sports already exactly 2 chars; unknown sports `.padEnd(2,"X")`) and `suffix` (`.padEnd(6,"0")`) are padded. `year`/`setSlug`/`cardNumberSlug` are ONLY capped via `slugify`, never padded — so total SKU length is "at most 41" (`SKU_MAX_LENGTH`), NOT always exactly 41. A short setName/cardNumber/year produces a visibly shorter string (e.g. `NB-BB-26-X-1-A1B2C3`). Only the true worst-case (every component at its max) hits exactly 41. Test both ends: a max-length case asserting `.length === 41` AND a short case asserting `.length < 41`.

`slugify` uppercases then strips `[^A-Z0-9]` — this strips accented letters entirely (toUpperCase doesn't fold diacritics to ASCII), not just emoji/punctuation. An empty result after stripping falls back to the literal `"X"`.

**fetchSportLotsChecklist setRadioId precedence (convex/adapters/sportlots.ts ~line 784-807):**
`parallel > insert > variantType > platformFilters.setName > parentFilters.setName-direct > DB lookup via resolveSportLotsPlatformValue`. The DB-lookup branch only fires when NONE of platformFilters.{parallel,insert,variantType,setName} are set AND parentFilters.setName is present. To exercise it you must seed a real `selectorOptions` row: `level: "setName"`, `value` matching `parentFilters.setName` (case/whitespace-insensitive match), `parentId: undefined` (root-level — `findByLevelAndValue`'s query is `by_level_and_parent` with `parentId` exactly matching what's passed, and `resolveSportLotsPlatformValue` here is called with no `parentId` arg), `platformData.sportlots` set to the expected radio id.

**Mocking pattern for admin-gated SL/BSC actions that need a credential cookie/token without seeding real encrypted creds:** `vi.mock("./credentials", ...)` (spread `importOriginal`, replace just `getSiteToken` with an `internalAction` stub returning `{ token: "..." }`). Combine with `vi.stubGlobal("fetch", ...)` (capture POST body via `new URLSearchParams(body).get("selset")`) for the outbound SL request, and `t.withIdentity({ role: "admin", ... })` for `requireAdmin`. This is the same module-replacement convention as `[[reference_fetchcardchecklist_multi_adapter_mock_pattern]]` but applied to `./credentials` instead of an adapter module.

**SKU wiring test fixture:** reused `featurePropagation.test.ts`'s `seedVariantTypeUnderChromeSet` tree exactly (sport "Baseball" -> setName "Chrome" with `features:{manufacturer:"Topps",season:"2024"}` -> variantType "Base") since both `commitCardChecklist` and `addCustomCard`'s SKU generation read the same ancestor shape. Expected sku format for that fixture: `/^NB-BB-2024-CHROME-<cardNumber>-[A-Z0-9]{6}$/`. Since `uniqueSuffix` is `crypto.randomUUID()` (real randomness, not mocked), uniqueness-across-cards tests just assert `sku1 !== sku2` rather than pinning exact suffix values — don't try to mock `crypto.randomUUID` for this, it adds no value over the real random UUID.

`addCustomCard` has NO dedup-by-cardNumber guard (unlike `addCustomSelectorOption`) — two custom cards with the identical `cardNumber` under the same `selectorOptionId` both insert as separate rows fine; useful for a same-cardNumber-different-sku uniqueness test without extra setup.
