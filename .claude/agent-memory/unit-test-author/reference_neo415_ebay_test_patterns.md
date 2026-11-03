---
name: neo415-ebay-test-patterns
description: NEO-415 eBay listing tests - convex-test ids fail the real SKU/id checks, a fake-eBay fetch class, in-flux product code, and where each suite lives
metadata:
  type: reference
---

- convex-test ids look like `00000000000010000selectorOptions` (digits plus the table name, mixed case), so `convexIdCodec.tableNumberOf` and `parseEbaySku`'s `[0-9a-z]{31,37}` regex refuse them. Drain tests `vi.mock("./lib/convexIdCodec")` to relax `tableNumberOf` (this also fixes `foldEbayTargets`, which calls `buildEbaySku` inside its own module, where a mock of the export would NOT reach). Sales tests `vi.mock("./lib/ebayListing")` to swap only `parseEbaySku` (listingSales imports it across modules). The real codec is pinned in `lib/ebayListing.test.ts` with ids from `encodeId`.
- Fake eBay = one `fetch` stub class holding items, offers, listings, media and taxonomy aspects; assert on what it holds, not on call counts alone. Browser-service routes (`/oauth/ebay/connect`, `/webhooks/ebay/verify`, `GET /credentials/<key>/token`, DELETE) ride the same stub, keyed on the browser origin.
- `new Response(null, {status: 204})` - never `Response.json(..., 204)`; 204 bodies throw.
- `test.each` + `vi.stubEnv("X", "")` is how env unset is simulated (the helpers trim empty to null).
- `t.run` returns `undefined` as `null`; assert `?? null`.
- Add copies BEFORE inserting the listing state: the add gate (listingGate) refuses an unpriced add once the owner lists.
- A copy keeps a card from being deleted in the real app, so drain tests delete the copy, then the card.
- Another builder edits product code in the same worktree while tests are written (disconnect, deletion webhook, link rows changed shape mid-task): re-run the suite before reporting and re-read the diff of the module under test.
- Never swap a product file for a mutation and restore it from a backup while other agents edit: copy-restore can clobber their edits. Prove a test red by a one-line edit through a throwaway copy of the test, or skip the break-check.
