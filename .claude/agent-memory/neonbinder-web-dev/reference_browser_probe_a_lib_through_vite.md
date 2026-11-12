---
name: browser-probe-a-lib-through-vite
description: To time or check a pure lib module in real Chromium, run a spare-port Vite and page.evaluate(import("/lib/...ts")) from a static same-origin page — the app root navigates away mid-evaluate
metadata:
  type: reference
---

Vite dev serves and transforms any module under `apps/web` by path, so a headless Playwright Chromium can run a pure library (parser, reader) with the real browser APIs and the real `?url` asset handling:

1. `VITE_DEV_DISABLE_HTTPS=1 npx vite --port <spare> --strictPort` (background).
2. In a scratch script: `page.goto("http://localhost:<port>/robots.txt")` — NOT `/`: the SPA's router/Clerk navigates and `page.evaluate` dies with "Execution context was destroyed".
3. Warm the imports once (first import pays the Vite transform: ~500 ms that is not the code's cost), then `page.evaluate(async (args) => (await import("/lib/x/y.ts")).fn(...))`, passing file bytes as base64.
4. `--enable-precise-memory-info` + `--js-flags=--expose-gc` for `performance.memory` heap deltas.

Used for NEO-496 probes P2/P3 (xlsx read ~90 ms / +23 MB on an 18k-row sheet; pdf.js worker confirmed same-origin via `page.on("request")`). Stop the Vite task afterwards. See [[pdfjs-6-driver-quirks]].
