---
name: probe-bsc-public-search-for-card-ids
description: To probe BSC's public card-listing endpoint you need a real card id; the shop search answers unauthenticated and returns ids plus playerAttribute/teamName for any query
metadata:
  type: reference
---

The repo's fixtures carry no BSC card ids, and the bulk-upload endpoints need a
seller token. The storefront's own search does not:

- `POST <BSC API base>/search/shop/results?q=<terms>` with JSON body
  `{"filters":{},"listingSearch":{},"page":0,"size":100,"sort":"best-sellers","inStock":false,"productCriteria":{"condition":null,"priceRangeStart":null,"priceRangeEnd":null}}`
  plus browser-ish `origin`/`referer` headers. A body missing those keys
  answers 400 or 500 ("field name cannot be null").
- Each result has `id`, `playerAttribute` (an ARRAY here, tokens may carry
  stray spaces: `["AU ", " SN50"]`) and `teamName` (an array).
- `GET /marketplace/card/<id>/card-listing` (no auth) then returns the
  per-card shape: `teamName` a string, `playerAttribute` a COMMA STRING
  ("AU, SN1", "AU ,  SN50", ""), and `playerAttributeAlias` (human words).

Quirks seen (NEO-345): `teamName` can hold the attribute label ("AU  SN1",
two spaces) with `playerAttribute` empty; tokens beyond the documented set
appear live (`FY`, `EXCH`, `MEM`).

**How to apply:** when a task says "probe BSC for a card with X", search a few
pages with a relevant `q`, filter the results locally, then fetch
card-listing for the ids you need. Read-only and unauthenticated; keep it to
a handful of requests (the limit is courtesy, not a quota).
