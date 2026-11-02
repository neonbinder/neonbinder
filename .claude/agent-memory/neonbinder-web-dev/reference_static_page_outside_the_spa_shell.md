---
name: static-page-outside-the-spa-shell
description: How apps/web serves a page that must NOT boot the app (no PostHog/Sentry/Clerk): public/ HTML, vercel.json rewrite before the catch-all, a vite plugin rewrite for dev AND preview, JS kept in lib/ and emitted; happy-dom fetches link/script on innerHTML
metadata:
  type: reference
---

NEO-422 (eBay OAuth return) needed a URL whose query string (an OAuth `code`)
must never reach analytics. Any SPA route mounts PostHog/Sentry/Clerk before a
redirect runs, so the page is standalone static HTML instead.

- **Files:** HTML + CSS in `public/<path>/`. Extensionless URLs need explicit
  `vercel.json` rewrites placed BEFORE the `/((?!assets|ingest|monitoring).*)`
  catch-all (Vercel checks the filesystem first, so `.js`/`.css` need nothing).
- **Vite:** dev and `vite preview` both fall back to index.html for an
  extensionless path. A small plugin rewrites `req.url` in `configureServer`
  AND `configurePreviewServer` (they are separate hooks). Public HTML is then
  served raw in dev (no `@vite/client` injected), checked with curl.
- **Shared JS:** importing a `public/` file from app code works but Vite warns
  "Files in the public directory are served at the root path" on every load.
  Keep the module in `lib/` (plain JS + JSDoc, allowJs gives TS types), serve
  it in dev with a middleware and `this.emitFile({type:"asset"})` it in
  `generateBundle` so dist carries it byte for byte.
- **Testing the HTML:** happy-dom tries to FETCH `<link rel=stylesheet>` and
  module `<script src>` when markup is set via `document.head/body.innerHTML`
  or DOMParser (logs NotSupportedError, test still passes). Parse into a
  `<template>`'s `.content` instead; it stays inert.
- **vite preview** needs `VITE_DEV_DISABLE_HTTPS=1` too, or mkcert asks sudo.

Related: [[static-markup-visual-check]], [[gates-in-a-shared-worktree]].
