---
name: ebay-media-500-is-ambiguous
description: eBay Media API 500 errorId 190000 ("internal system or process") is also returned for malformed requests; how to rule out NB's request without calling eBay (OpenAPI spec, Convex runtime FormData source, Node multipart test)
metadata:
  type: reference
---

eBay's Media API (`/commerce/media/v1_beta`) answers 500 with errorId 190000
for its own outages AND, per an eBay Community thread, for requests missing
required parts. Never read a 190000 as "eBay is down" until the request is
ruled out.

How to rule it out without calling eBay:
- The machine-readable contract is the OAS3 file
  (`developer.ebay.com/api-docs/master/commerce/media/openapi/3/commerce_media_v1_beta_oas3.json`);
  the HTML method pages are JS-rendered and WebFetch sees nothing on them.
  It gives: scope `sell.inventory`, `Content-Type: multipart/form-data`,
  form field `image`, 201 + `Location` header, 400 ids 190201/190202/190203
  for the file itself, 403 190013.
- The Convex default runtime builds multipart itself:
  `get-convex/convex-backend` → `npm-packages/udf-runtime/src/21_formdata.ts`
  (`formDataToBlob`: boundary, `name=…; filename=…`, part `Content-Type`) and
  `23_request.ts` (sets content-type and content-length). Read it with
  `gh api repos/get-convex/convex-backend/contents/<path>`.
- In vitest, `new Response(formData)` encodes it the Node way; assert the raw
  part header text (`ebaySeller.test.ts` has the pin).

The drain treats a 400 on upload as that card's picture refused (problem,
row cleared) and anything else as the photos step stopping (row kept, run
ends naming the photos step). Related: [[ebay-sandbox-diverges-from-the-contract]].
