---
name: cross-adapter-parity-test
description: To prove BSC and SportLots agree on a card (no name/roster conflict), run BOTH real adapter actions in one convex-test file with fetch routed by URL, then feed the output to lib/cards/card-name helpers; never replicate an adapter's naming rule in the test
metadata:
  type: reference
---

A "these two marketplaces now agree" claim is only proven when both REAL
adapter actions produce the rows. Each adapter builds `cardName` inside its
fetch action (BSC joins `parsePlayersField` players; SportLots derives from
the tokenizer residual), so a test that calls the pure parsers and re-joins
the name itself only proves the replica agrees with itself.

**How to apply:** one convex-test file at the `convex/` root (glob reason in
`convex/sportlots.test.ts`): `vi.mock("./credentials")` returning a token for
any site plus no-op `authenticateBsc`/`authenticateSportlots`; one
`vi.stubGlobal("fetch")` that answers listcards HTML when the URL contains
"sportlots" and a BSC bulk-upload JSON array otherwise; call
`fetchBscChecklist` (with `facetFilters` sport/year/setName/variant, or it
refuses) and `fetchSportLotsChecklist` (`platformFilters.variantType`); pair
by card number and assert `conflictingNames`/`conflictingPlayers` are
undefined. Assert both rosters are NON-empty first, because
`conflictingPlayers` is silent when one side is empty. Keep one real
disagreement row as a control so the helpers are shown still speaking, and
neutralise the fix once to see the parity test go red. Example:
`convex/sportlots.teamCard.test.ts` (NEO-343).
