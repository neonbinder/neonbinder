---
name: intake-tab-test-mocks-store-wholesale
description: RealAddCardsTab.test.tsx replaces ../data/store with a hand-written mock, so any new store hook or any import that reaches mode.tsx (ParamLink) breaks the whole file at import time
metadata:
  type: reference
---

`app/collection/final/intake/RealAddCardsTab.test.tsx` mocks `../data/store` with a small object literal (no `importOriginal`). Two consequences when RealAddCardsTab (or anything it imports) grows:

- A new store hook the tab calls (e.g. `useListingGate`) is `undefined` in the mock: add it there.
- Importing anything that reaches `app/collection/final/mode.tsx` (`ParamLink`, `useCollectionParams`) fails the FILE with `No "ScopeProvider" export is defined on the "../data/store" mock`, because mode.tsx imports `ScopeProvider` from the store. Mock `../mode` in that test with a plain `<a href={"?" + new URLSearchParams(search)}>` stand-in.

Component tests that render a real `ParamLink` (SyncButton, QuantityRow, InventoryChecklist rigs) must wrap it in `<CollectionModeProvider mode="app" surface="inventory">` inside a `MemoryRouter`, or it throws `useLatestEntry: outside CollectionModeProvider`.

A label wrapping both an input and its help text makes the help part of the accessible name; put the help outside the `<label>` and point at it with `aria-describedby`, or `getByRole("textbox", { name })` misses it. See [[reference_wrapping_label_select_name_includes_option]].
