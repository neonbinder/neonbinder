---
name: tcdb-adapter-credential-free
description: TCDB adapter is public/credential-free; its browser lifecycle is owned by module-scope scrape functions, so route-level cleanup() is an intentional no-op
metadata:
  type: project
---

The TCDB adapter (`src/adapters/tcdb-adapter.ts`, added in NEO-38 / PR #43) is a first-class `class TcdbAdapter extends BaseAdapter` but is fundamentally different from the credentialed adapters (BSC, SportLots): TCDB is a fully public site. There is **no `/login/tcdb` route, no Secret Manager access, and no credential handling** anywhere in it. `login()` is a deliberate no-op that ignores its `key` argument. `requiresAuth = false`, `supportsListing = false`. The two routes are `POST /tcdb/search` and `POST /tcdb/get-set` in `src/index.ts`.

**Why:** TCDB is the public fallback source of set-level catalog metadata (release date, card count, block/series) when BSC/SportLots responses come back thin. It is gated behind Cloudflare's JS interstitial, so it must be scraped via Puppeteer rather than plain HTTP.

**How to apply (for future security reviews of TCDB code):**
- Do NOT flag the route-level `await adapter.cleanup()` as a leak/no-cleanup risk. For TCDB it is an *intentional* no-op: the real browser lifecycle is owned by the module-scope functions `searchTcdbSets` / `getTcdbSetMetadata`, which each `launchBrowser()` and close via `safeClose(browser)` in their own `finally`. `TcdbAdapter` never calls `launchPage()`, so `this.browser` is never set and BaseAdapter.cleanup() has nothing to close. This still satisfies the repo's [[project_puppeteer_cleanup_invariant]] (every launch paired with a close), just at module scope instead of route scope.
- SSRF surface is already closed by defense-in-depth: `tcdbSetId` is validated `/^\d+$/` at BOTH the route and inside `getTcdbSetMetadata`; the host is the hardcoded `TCDB_ORIGIN` constant; search keywords go through `encodeURIComponent` into the `Keywords` query param only. Re-verify these still hold if the nav URLs are edited.
- Scraped data that reaches the client (`matches`, `metadata.additionalFeatures`) is set-level catalog metadata from a public site — not user PII or credentials — so returning it in responses is allowed. Don't treat raw scraped key/value pairs as a sensitive-data leak unless a future change starts scraping user/account pages.
- `withRetry` retries once on non-`TcdbUnavailableError`; each attempt launches+closes its own browser, so worst case is ~2 full 30s scrapes per request. Bounded and self-cleaning, but watch Cloud Run concurrency/memory if this is ever parallelized.
