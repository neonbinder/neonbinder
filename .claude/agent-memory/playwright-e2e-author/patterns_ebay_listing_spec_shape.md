---
name: ebay-listing-spec-shape
description: NEO-415 eBay sandbox listing spec shape - seed-hop connect, loud fail when unwired, Set me up branch, provisional round-trip ceiling, Sync status now has two regions
metadata:
  type: reference
---

- eBay connects by OAuth, so a spec cannot drive consent: `saveEbayConnection` (support/credentials.ts) uses the seed hop `sites=ebay[&listing=on]`. The hop SKIPS (not fails) when eBay is unwired, the token is unset or eBay is paused, so the spec's next assert must name the missing setup (`expectEbayHookedUp` throws on "isn't hooked up"). No sanctioned skip exists for a missing credential: GUIDE only has the PAUSED_PLATFORMS switch (`env.EBAY_PAUSED` paused branch).
- Sync status always renders BOTH platform regions (bsc and ebay, "Not connected" included), each with its own "Nothing syncing right now." line: any unscoped read of that screen is a strict-mode hit. Scope through `getByRole("region", { name })`.
- The `Switch` primitive is an `<input type=checkbox>`: role `checkbox`, never `switch`.
- "Set me up" is offered only while the seller account lacks a fitting policy; a second run finds the policies and the button is gone. Settle on the "Shipping" heading, then branch on the button, and end both branches on a click of the first radio in each policy group plus the "N to go" checklist status.
- Ships-from form remounts on save (keyed by saved value), so its "Saved." line flickers: prove the save by the checklist ("You're all set"), not that line.
- Live eBay steps share one named ceiling (`EBAY_ROUND_TRIP`), PROVISIONAL until Jason signs it off (GUIDE rule 3); say so at the site.
- Disconnect through the product withdraws live listings, drops the queue and deletes the settings, so a spec that ends Disconnected leaves the account as the bootstrap left it.
