---
name: adapter-error-string-is-body-and-classifier
description: In services/browser an adapter's `error` string is BOTH the HTTP response body and the input to classifyBrowserError — sanitising it costs error_class granularity, so check the class map before making one generic
metadata:
  type: reference
---

An adapter's `AdapterResponse.error` is used twice by `src/index.ts`'s login
routes, and it is easy to only notice one:

1. It goes verbatim into the failure response body (`res.status(status).json({
   error: result.error, ... })`), which `apps/web/convex/credentials.ts` reads
   as `detail` and `recordCredentialTest` forwards to PostHog.
2. It is passed as `raw` to `loginFailureOutcome(result, result.error)`, whose
   fallback is `classifyBrowserError(raw)` — a substring map producing
   `bad_key_format` / `reauth_required` / `automated_access` / `timeout` /
   `invalid_credentials` / `challenge` / `oom` / `other`.

So making that string generic (the right call for leak containment) silently
downgrades `error_class` to `other` on any branch that used to be classified
from the free text. Before doing it, check which classes the branch could
produce and whether anything downstream splits on them:

- The **status code** is safe: `loginFailureOutcome` decides 422 vs 502 from
  the `reauthRequired` / `challengeDetected` / `credentialRejected` FLAGS, not
  the text. Sanitising the text cannot turn our fault into the seller's.
- Convex's `TRANSIENT_ERROR_CLASSES` treats `other` and `timeout` identically,
  so losing `timeout` there changes nothing user-visible.
- `challenge` and `automated_access` (`SITE_SIDE_ERROR_CLASSES`) and
  `invalid_credentials` / `reauth_required` are all set by explicit flags or by
  purpose-built literal strings on `return` paths — never derived from a caught
  error — so they survive.

The class you actually lose by generifying a `catch` branch is
`bad_key_format`. That is a Convex-caller bug, still 502, still pages.

Related: [[credential-key-format-and-ratelimit]],
[[bsc-b2c-login-secret-discipline]].
