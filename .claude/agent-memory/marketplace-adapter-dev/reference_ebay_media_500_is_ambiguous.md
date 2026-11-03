---
name: ebay-media-500-is-ambiguous
description: eBay Media API 500 errorId 190000 is also returned for malformed requests and for every upload on the sandbox (no picture upload there, the drain skips it); the sandbox still refuses items with empty imageUrls (25717), so sandbox items carry one fixed self-hosted test picture; how to rule out NB's request and read eBay's JS-rendered method pages
metadata:
  type: reference
---

eBay's Media API (`/commerce/media/v1_beta`) answers 500 with errorId 190000
for its own outages AND, per an eBay Community thread, for requests missing
required parts. Never read a 190000 as "eBay is down" until the request is
ruled out.

**The image methods do not exist on the sandbox.** eBay's method pages for
`createImageFromFile` and `createImageFromUrl` say "This method is not
supported in Sandbox environment." On `apim.sandbox.ebay.com` both answer
500 / 190000 to every well-formed request (signed-in user token with
`sell.inventory`; our headers, Authorization only, and a public HTTPS URL all
fail alike). An app-only (client-credentials) token gets 403 / 1100 instead.
Read that line on the method page before calling any eBay method on the
sandbox; the OAS3 file does not carry it. The drain therefore skips the
upload on the sandbox behind one predicate (`ebayHasPictureUpload` in
`lib/ebayEnv.ts`). But eBay's "Required fields for publishing an offer"
guide lists `product.imageUrls` as required to publish, and the Product
field says "at least one image URL must be specified before an offer can be
published", with no sandbox exception on either page.

**And the sandbox enforces it, earlier than publish.** A picture-less item
is refused at `bulkCreateOrReplaceInventoryItem` itself, per item: errorId
25717 "imageUrls cannot be null or empty." (parameter `imageUrls`). The
lever is that `product.imageUrls` accepts self-hosted HTTPS URLs: on the
sandbox only, every item sent carries one fixed public NB-hosted image of a
fictional test card (`EBAY_SANDBOX_TEST_PICTURE_URL`, beside the predicate in
`lib/ebayEnv.ts`; the drain sets it where the predicate is read, nowhere
else). It is never stored as a card's picture (link `images` stay empty)
and stays out of the item content fingerprint, which hashes the copy's own
photo keys, so an unchanged card is not resent each run and a retaken photo
still resends it. Production never reads it. If you add a sandbox
divergence like this, keep the env check in that one place and pin it with
a test that goes red when the substitute is removed.

Reading those pages: `developer.ebay.com/develop/api/sell/<api>` is one
JS-rendered page per API (the old `api-docs/.../methods/<m>` URLs redirect
to an anchor on it). WebFetch sees only the nav. In the built-in browser,
filter `document.body.innerText` lines for "Sandbox environment" after the
anchor loads; each method's Input says "is supported" or "is not supported
in Sandbox environment". Field descriptions are not in the rendered text;
take those from the OAS3 file.

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
