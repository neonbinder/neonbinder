---
name: reference-ebay-inventory-offset-is-a-page-number
description: eBay's inventory_item list takes offset as a page number, unlike getOrders; follow the next link instead of adding limit
metadata:
  type: reference
---

`GET /sell/inventory/v1/inventory_item` reads `offset` as a PAGE NUMBER (first page 0, second 1), per the Sell Inventory contract. `getOrders` reads it as a record offset. Adding `limit` to it silently skips items.

**How to apply:** take the `offset` out of eBay's own `next` link and fail on a `next` you can't read, so a partial listing is never taken for the whole one. See `getInventorySkusPage`. The sandbox behaviour itself is unverified until a real run. Related: [[reference-ebay-sell-api-shapes-come-from-the-oas-specs]].
