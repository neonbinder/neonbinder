---
name: reference-failed-dynamic-import-is-cached-per-document
description: Chromium remembers a failed dynamic import for the life of the document, so a re-import or a lazy retry cannot recover it; only a reload can
metadata:
  type: reference
---

In Chromium, once `import(url)` has failed, importing the same URL again in the same document rejects without recovering, even when the server now answers. A new document resolves it (measured with Playwright against a production build and Vite dev, NEO-434).

**Why it matters:** "a failed prefetch is harmless, the route retries when it renders" is false there. A warm-up that fails on a network blip makes the later route render fail too. `src/routes/chunk-reload.tsx` recovers that with one guarded reload.

**How to apply:** never plan an in-page retry of a dynamic import as the recovery. Two comments still claim the old behaviour (`app/landing.tsx`, `app/binder-tracking/page.tsx`) unless since corrected.

Spec gotcha beside it: Playwright's `page.on("request")` fires before a `page.route` predicate runs, so a "not seen yet" predicate over a live set never matches. Snapshot the set when arming. Unit gotcha: in happy-dom `vi.spyOn(Storage.prototype, ...)` does not intercept `sessionStorage`; spy the `window.sessionStorage` getter instead.
