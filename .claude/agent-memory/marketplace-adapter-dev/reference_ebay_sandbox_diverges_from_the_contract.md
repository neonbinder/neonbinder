---
name: ebay-sandbox-diverges-from-the-contract
description: eBay Sell API answers that differ from the OAS contract on a live sandbox run - location create on an existing key is 400, Ground Advantage behind an older code, Media Location header, eSE policy refused 20403 whatever the costType
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
- **ESE fulfillment policy in the sandbox** is refused with errorId 20403,
  CALCULATED (NB's run) and FLAT_RATE + freeShipping (a community poster,
  whose longMessage was "Please select a valid shipping service", parameter
  XPATH `DomesticItemShippingService[0].shippingService`). eBay's only
  published eSE example is FLAT_RATE; nothing documents CALCULATED either way.
- **20403 is a template**, "Invalid {fieldName}. {additionalInfo}" in the
  Account contract; it is also returned for a bad policy id and for a seller
  not opted in. The id alone never names the field.
- `ebayServiceTakesCalculated` answers true when the code is ABSENT from the
  metadata (unknown is not no), so it passing proves nothing about whether
  eBay lists the service at all.

**How to apply:** the `ebay_seller_error` line in `adapters/ebaySeller.ts`
logs `errorIds` plus `errors[]` (message, longMessage, parameters,
inputRefIds) redacted by `redactEbayText`; read those before guessing a body
change. Treat every documented status/field as a hypothesis until a sandbox
run confirms it.
