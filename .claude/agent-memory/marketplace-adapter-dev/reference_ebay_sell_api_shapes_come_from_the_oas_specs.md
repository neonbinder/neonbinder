---
name: ebay-sell-api-shapes-come-from-the-oas-specs
description: eBay's developer doc pages do not yield request/response schemas to a fetch; read shapes from each API's OpenAPI contract file; bulk Sell endpoints answer 400 with per-entry results; linked-out enums and loose metadata cost types
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
- `deleteInventoryItem` also deletes the SKU's unpublished offers and
  single-variation listings. The contract lists a missing SKU under 400/25702
  as well as a bare 404, so a 404 check alone may not catch "already gone".
- The fulfillment-policy create path carries a trailing slash in the spec.
- Enums the contract only links to (Inventory `PackageTypeEnum`) are absent
  from the JSON and the doc page is a JS app; a generated SDK on GitHub
  (`gh search code PADDED_BAGS`) lists the REST values (LETTER, PADDED_BAGS).
- Metadata `shippingCostTypes` is free text in practice (community answers
  show `["CALCULATED","FLAT"]`, not FLAT_RATE): match CALCULATED
  case-insensitively and treat an empty list as unknown, never as "no".
- The eBay drain's item `contentHash` decides whether an item is resent; any
  field the item body carries (package weight follows the price slot) must
  be in the hash, or a live listing never gets the change.

**How to apply:** mark every field that came from prose or memory rather than
the contract as UNVERIFIED in a code comment and in the report.
