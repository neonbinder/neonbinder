---
name: ebay-sandbox-refuses-ese-policy
description: eBay sandbox createFulfillmentPolicy refuses US_eBayStandardEnvelope with 20403 "Please select a valid shipping service" even though sandbox getShippingServices lists it validForSellingFlow true; no body variant fixes it
metadata:
  type: reference
---

eBay's **sandbox** refuses `US_eBayStandardEnvelope` (eSE) in a fulfillment
policy: 400, errorId 20403, longMessage "Please select a valid shipping
service.", XPATH `DomesticItemShippingService[0].shippingService`. The sandbox
Metadata `getShippingServices` still lists eSE (carrier `EBAY_SEND`,
validForSellingFlow true, cost types CALCULATED and FLAT, 3 oz limit), so a
metadata pre-check cannot predict the refusal.

Evidence (2026-11): a public eBay community thread
(community.ebay.com, fulfillment forum, "Trying to create a fulfillment policy
for eBay's standard envelope (eSE)") shows the identical error for carrier
USPS, EBAY_SEND and "eBay Standard Delivery", FLAT_RATE + freeShipping, no
reply from eBay. NB saw it with CALCULATED, with and without a carrier code.
The Account contract says valid service codes come from Trading
`GeteBayDetails` ShippingServiceDetails, and that thread reports eSE missing
from the sandbox's GeteBayDetails carriers: the policy validator likely reads
the legacy table, not the Metadata API.

Production sellers do carry eSE policies (CALCULATED, carrier "eBay Send"),
but those were made in Seller Hub, not through the API, so API creation on
production is plausible but unproven.

**How to apply:** never "fix" a sandbox 20403 on eSE by changing the body or
switching to FLAT_RATE; the `ebay_policy_service_refused` log line in
`ebayConnect.ts` records what the metadata said. Sandbox E2E must prove the
listing flow without eSE. See [[action-stubs-pin-old-return-shapes]] for the
adapter-shape rule if the metadata narrowing changes again.
