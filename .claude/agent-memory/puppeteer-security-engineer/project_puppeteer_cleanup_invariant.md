---
name: Puppeteer cleanup invariant in neonbinder_browser
description: Every adapter.login() call must be wrapped in try/finally with adapter.cleanup() in route handlers, or Cloud Run OOMs after ~10 requests
type: project
---

In `neonbinder_browser`, BaseAdapter.launchPage launches a Puppeteer Browser child process (~150-200 MiB resident). The Browser handle is now tracked on `this.browser` and an idempotent `cleanup()` method closes it. Every adapter call in `src/index.ts` route handlers MUST be wrapped in `try { adapter.login(...) } finally { adapter.cleanup() }`.

**Why:** Before the 2026-05-03 fix (PR #23), the Browser handle was local-scope to launchPage and `browser.close()` was never called. Each cache-invalid → fresh-login path leaked a Chromium process. After ~10 logins on the same Cloud Run instance, the 2048 MiB memory ceiling OOM-killed the container mid-request. User-facing symptom was the misleading "BSC login failed. Please check your credentials and try again." toast even when BSC had accepted the login — the response just never made it back to Convex because the container died first.

**How to apply:**
- When adding a new adapter route handler in `src/index.ts`, declare the adapter outside the try block and add `finally { await adapter.cleanup(); }`.
- When adding a new branch in an adapter's `login()` that calls `launchPage()`, no extra work is needed — cleanup is a route-level concern.
- `cleanup()` is idempotent and swallows errors from `browser.close()` so try/finally never masks the original error.
- SportLots is pure HTTP today; cleanup() is a safe no-op for it. The invariant is still applied uniformly so any future Puppeteer-using SL flow is covered.
- The OOM log signature in Cloud Run is: `Memory limit of 2048 MiB exceeded with NNNN MiB used. ... container instance was found to be using too much memory and was terminated.` — search for this when triaging "marketplace login flakes after a few attempts".
