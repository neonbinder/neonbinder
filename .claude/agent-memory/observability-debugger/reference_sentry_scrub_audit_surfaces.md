---
name: sentry-scrub-audit-surfaces
description: What a Sentry or Replay URL-secret scrub audit must cover, which surfaces no hook reaches, and how JSON-text regexes go wrong
metadata:
  type: reference
---

An audit of a URL-secret scrub in `apps/web` has to walk these, because each one
passed a review that only looked at `http.url` (NEO-434).

**Surfaces**
- A span's `http.query` holds the query with no host, so a host-anchored pattern misses it.
- Breadcrumbs are unfiltered by the SDK; only `beforeBreadcrumb` touches them.
- Every storage host: Google, R2 (the account id is in the hostname), Convex
  `?token=` uploads, and Convex `/api/storage/<id>` reads, which never expire.
- PostHog autocapture puts a clicked image's `src` in `attr__src`.

**What no hook reaches**
- `beforeAddRecordingEvent` fires only for rrweb custom frames. Snapshots,
  mutations and the Meta frame skip it.
- `replay_event` skips `beforeSend` and `beforeSendTransaction`, and carries the
  address in `urls[0]` and `request.url`.
- So a value on the address must be gone before `Sentry.init`, and a bearer in the
  DOM must be blocked.
- rrweb returns early for `href`, so `maskAttributes` does nothing to a link. Only
  a `block` selector works. Images are covered by Replay's default media blocking.

**Regexes over JSON text** (stringify, replace, parse)
- A pattern can start on an escape's letter: `n` in `\n` is a valid label character.
  Eating it leaves a lone backslash, the parse throws, and the event silently drops.
- A look-behind for a word character sees that same `n`, or the `6` of `&`, and
  skips a real parameter. A `%26` prefix fools it the same way.
- Prove it with every ordered triple of escapes and shapes. A hand-rolled LCG taken
  modulo a small number repeats too soon and missed a known break.

**Real proof under vitest happy-dom**
- `@sentry/react` and Replay run for real in buffer mode: tag `process` so
  `isBrowser()` is true, and mock `Math.random` above the session rate.
- rrweb itself starts only if `window.NodeList` and `window.DOMTokenList` exist, and
  then it emits real snapshots and mutations.
- Replay holds back anything under five seconds, so mock `Date.now` before `flush()`.
- Read `client.getTransport().send`, with a control value that must appear so an
  empty recording cannot pass.
- Not reachable there: the navigation-timing entry, a real `document.referrer`, and Back.
