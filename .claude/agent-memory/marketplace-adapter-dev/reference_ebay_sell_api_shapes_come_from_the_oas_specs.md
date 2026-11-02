---
name: ebay-sell-api-shapes-come-from-the-oas-specs
description: eBay's developer doc pages do not yield request/response schemas to a fetch; read shapes from each API's OpenAPI contract file, and expect bulk Sell endpoints to answer 400 with per-entry results
metadata:
  type: reference
---

Fetching developer.ebay.com method pages returns navigation and prose, not the
field tables. Each REST API (Sell Inventory, Account, Fulfillment, Metadata,
Taxonomy, Commerce Media) publishes an OpenAPI 3 JSON contract linked from its
overview page; download it to the scratchpad and read schemas from it (a short
python walk over `components.schemas`). Some contracts omit things anyway:
Media `createImageFromFile` has no `requestBody` (the multipart field name is
unverified), and condition-descriptor value ids are not in the Metadata spec.

Quirks worth remembering when building on them:

- Bulk Inventory calls (`bulk_create_or_replace_inventory_item`,
  `bulk_create_offer`, `bulk_publish_offer`, `bulk_update_price_quantity`)
  answer HTTP 400 with a normal `responses[]` body when EVERY entry failed
  (207 when some did). Read the body on 400 before treating the call as failed.
- `createOffer` for a SKU that already has one fails per entry with error
  25002; adopt the existing offer via `getOffers?sku=` rather than failing.
- The fulfillment-policy create path carries a trailing slash in the spec.

**How to apply:** mark every field that came from prose or memory rather than
the contract as UNVERIFIED in a code comment and in the report.
