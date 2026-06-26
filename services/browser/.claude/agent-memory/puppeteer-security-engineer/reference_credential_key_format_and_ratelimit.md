---
name: credential-key-format-and-ratelimit
description: Credential-key format ($site-credentials-$userId), where it's validated vs. where the rate-limiter keys on it, and why per-key rate limiting is the correct model behind the Cloud Run IAM gate
metadata:
  type: reference
---

Credential key format (the `:key` URL param / `key` body field, NOT a secret):
`${site}-credentials-${userId}`, validated by `KEY_PATTERN = /^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$/`
in `src/services/secrets-manager.ts` (`validateKeyFormat`). username/password are ALWAYS
separate body fields on `PUT /credentials/:key` — the key never contains the secret.

Rate limiter (`src/index.ts` global `limiter` → `credentialRateLimitKey` in `src/rate-limit.ts`):
keyed PER CREDENTIAL KEY as `cred:${credKey}`, where `credKey` is read from `req.path` FIRST
(parse the `:key` segment of `/credentials/:key*`, excluding `/credentials/check`), then
`req.params.key` / `req.body.key` / `req.body.keys?.[0]` as fallbacks, finally
`ipKeyGenerator(req.ip ?? "")` for keyless routes (/health, /sites). MUST read `req.path` not
`req.params` because the limiter is GLOBAL middleware (`app.use`) running BEFORE route matching,
so `req.params` is empty there — reading it collapsed every URL-keyed route (incl. PUT
/credentials) to the IP bucket (the NEO-47 bug the per-key isolation test caught). `ipKeyGenerator`
is a real runtime export of express-rate-limit (v8.x).

**Why per-key is correct here (not per-IP):** the ONLY caller is the `neonbinder-convex` SA
(Cloud Run IAM, `roles/run.invoker`; everyone else gets 403 before Express — auth note at
`index.ts` ~line 118). All traffic arrives from Convex's single egress IP, so an IP-keyed
limit collapses to ONE global bucket shared by all users → parallel E2E workers / concurrent
users 429 each other, silently dropping credential STOREs. The limiter is therefore a
runaway-loop / fan-out fairness guard, NOT an anti-DoS perimeter (IAM is the perimeter).

**Security facts to reuse when reviewing this limiter (verified against express-rate-limit@8.3.1):**
- `standardHeaders: true` normalizes to draft-6, which emits NO partition key in headers. Only
  draft-8 (`setDraft8Headers`) puts a hashed `pk=:...:` in the RateLimit-Policy header — that
  path is not reached. So the key never leaks via response headers.
- Default MemoryStore is a two-generation sliding window (`previous = current; current = new Map()`
  each window) → keys self-evict in ~2 windows; cardinality is bounded by distinct keys per window,
  not cumulative. No unbounded-memory DoS.
- Key is used only as a JS Map key — no injection surface. `cred:` prefix namespaces it away from
  the IP-fallback keyspace.
- The `keyGenerator` runs BEFORE the route handler's `validateKeyFormat`, so a malformed key
  creates a transient bucket before the handler 400s it — theoretical only given the single trusted
  caller + 10kb json body cap + 2-min eviction.

See also [[project_puppeteer_cleanup_invariant]], [[feedback_bsc_b2c_login_secret_discipline]].
