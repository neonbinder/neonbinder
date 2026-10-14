---
name: patterns-testing-endpoint-gate
description: NeonBinder E2E/testing endpoint security pattern — TESTING_RESET_SECRET prod fail-closed gate, the per-user getCurrentUserId scoping vs the unauthenticated-runner gap, and the CI-integrity (false-green) angle for env-gated public Convex mutations
metadata:
  type: project
---

NeonBinder has two layers of "testing-only" endpoints, both designed to fail closed in prod:

**Convex layer** (`convex/testing.ts`): public `mutation`/`action`/`query` that throw unless `process.env.TESTING_RESET_SECRET` is set. That var is set on dev + preview Convex deployments ONLY, never prod — so the function throws in prod. This is presence-check, not value-check (on/off flag). The secret value is never sent to the client (a secret passed through a test runner's args or env can leak into a public CI artifact — see NEO-29).
- `resetMyTestState` / `seedMyTestCredentials` ALSO scope to `getCurrentUserId(ctx)` — a signed-in user can only touch their OWN rows, no clerkUserId arg to spoof. Creds are read from Convex server env (DEV_BSC_*/DEV_SPORTLOTS_*), returned summary is booleans only.

**Vercel layer** (`api/auth/testing.ts`, planned `api/e2e/*`): the 6-layer gate to replicate IN FULL — (1) opt-in env var present, (2) hard `VERCEL_ENV !== preview/development → 404`, (3) `x-testing-auth === TESTING_ENDPOINT_SECRET` strict compare (undefined-safe so missing server secret = always-fail), (4) input allowlist, (5) short token TTL where relevant, (6) audit log that logs ip/account/email but NEVER the secret. TESTING_ENDPOINT_SECRET is a GH Actions secret routed to the bash runner's curl, NEVER into a test's args or env (and never into an uploaded artifact).

**Retired queue (history, NEO-49 / NEO-341):** the suite once drained a Convex-hosted work queue (`e2eQueue.seedQueue/claimNext/markResult/getStatus`) whose callers were unauthenticated runners, so the only Convex-layer gate was `TESTING_RESET_SECRET` presence, and a `secret` arg compared to a preview-env secret was added to close the direct-to-Convex bypass. That queue was removed when the E2E suite moved to Playwright with static shard plans (`shard-plan.mjs`); the lessons that survive for ANY endpoint feeding the merge-blocking `e2e` gate:
- Data-exposure severity is LOW (ephemeral preview, no PII/creds/product data), but the real risk is **CI integrity**: main auto-deploys to prod on merge, so an unauthenticated write to the gate's result store is a forced **false-green** = a broken PR passes. That is a prod consequence regardless of data sensitivity.
- Fail closed when the secret is unset (even `""` is falsy), keep the secret header-only under `set +x`, never in a test arg or env map, and never `echo` the curl that carries `x-testing-auth`.
- Validate any value that flows back to a shell runner at the boundary with a strict allowlist and an explicit `..` reject; bound array-insert args.
- Artifacts: Playwright traces record Clerk testing tokens and must never be uploaded (the repo is public). "Screenshots and reports only" is NOT a scope: the blob/HTML report embeds error-context ARIA snapshots (input values in plaintext) - see [[patterns-playwright-report-exposure]].
- A secret compare using plain `!==` rather than `timingSafeEqual` is INFORMATIONAL only (HTTPS header, no per-char oracle, high-entropy secret).


**Verification caveat:** the prod fail-closed guarantee reduces to "TESTING_RESET_SECRET / TESTING_ENDPOINT_SECRET absent in prod Convex + prod Vercel." A fresh worktree isn't linked to a deployment, so you can't confirm it from there — say so, and recommend `npx convex env list --prod`. Also a footgun: TESTING_RESET_SECRET now gates MULTIPLE features; setting it in prod for any reason silently opens all of them. A dedicated per-feature flag decouples them.

See [[patterns_convex_auth_boundary]] — that covers requireAdmin for signed-in operator tooling; THIS covers env-gated runner/testing endpoints where the caller is NOT a signed-in user.
