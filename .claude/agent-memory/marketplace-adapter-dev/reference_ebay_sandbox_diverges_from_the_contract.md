---
name: ebay-sandbox-diverges-from-the-contract
description: eBay Sell API answers that differ from the OAS contract on a live sandbox run - existing inventory location answers create with 400 not 409, Ground Advantage hides behind an older service code, Media create may need the Location header
metadata:
  type: reference
---

First live eBay sandbox run of NEO-415 (2026-11-02) showed the contract
([[ebay-sell-api-shapes-come-from-the-oas-specs]]) is not enough on its own:

- **Inventory location create on a key that exists answers 400**, not the
  contract's 409. A location outlives NB's Disconnect, so every save after
  the first hits it. Read first (`GET /location/{key}`, 404 = absent), then
  create or `update_location_details` (warehouse address may change any
  number of times), `enable` if DISABLED. Never branch on the exists status.
- **USPS Ground Advantage has no code that says so** in the sandbox's
  `get_shipping_services` (a code-only `/groundadvantage/i` match found
  nothing). Sellers report eBay kept `USPSParcel` for it after the 2023
  rename (unconfirmed). Match the code first, then the metadata's localized
  `description` ("USPS Ground Advantage"), exactly-one at each step.
- **Media `create_image_from_file`**: the contract types a 201 ImageResponse
  body but tells callers to take the image id from `Location` and call
  `getImage`. Handle both; call the configured media host, never the
  header's host.
- **ESE fulfillment policy in the sandbox** was refused with errorId 20403
  for one community poster (FLAT_RATE, freeShipping). Unconfirmed for
  CALCULATED.

**How to apply:** log eBay's numeric `errorIds` on every non-2xx (the
`ebay_seller_error` line in `adapters/ebaySeller.ts`); a red live run
without them cannot tell one refusal from another. Treat every documented
status/field as a hypothesis until a sandbox run confirms it.
