---
name: patterns-testing-endpoint-gate
description: NeonBinder E2E/testing endpoint security pattern — TESTING_RESET_SECRET prod fail-closed gate, the per-user getCurrentUserId scoping vs the unauthenticated-runner gap, and the CI-integrity (false-green) angle for env-gated public Convex mutations
metadata:
  type: project
---

NeonBinder has two layers of "testing-only" endpoints, both designed to fail closed in prod:

**Convex layer** (`convex/testing.ts`, `convex/e2eQueue.ts`): public `mutation`/`action`/`query` that throw unless `process.env.TESTING_RESET_SECRET` is set. That var is set on dev + preview Convex deployments ONLY, never prod — so the function throws in prod. This is presence-check, not value-check (on/off flag). The secret value is never sent to the client (unlike a Maestro `-e` secret, which leaks — see NEO-29).
- `resetMyTestState` / `seedMyTestCredentials` ALSO scope to `getCurrentUserId(ctx)` — a signed-in user can only touch their OWN rows, no clerkUserId arg to spoof. Creds are read from Convex server env (DEV_BSC_*/DEV_SPORTLOTS_*), returned summary is booleans only.

**Vercel layer** (`api/auth/testing.ts`, planned `api/e2e/*`): the 6-layer gate to replicate IN FULL — (1) opt-in env var present, (2) hard `VERCEL_ENV !== preview/development → 404`, (3) `x-testing-auth === TESTING_ENDPOINT_SECRET` strict compare (undefined-safe so missing server secret = always-fail), (4) input allowlist, (5) short token TTL where relevant, (6) audit log that logs ip/account/email but NEVER the secret. TESTING_ENDPOINT_SECRET is a GH Actions secret routed to the bash runner's curl, NEVER to Maestro `-e`.

**The gap to watch for (NEO-49 OPEN QUESTION, MEDIUM finding):** a runner is NOT a signed-in user, so queue-style endpoints (`e2eQueue.seedQueue/claimNext/markResult/getStatus`) have NO `getCurrentUserId` — the ONLY gate at the Convex layer is `TESTING_RESET_SECRET` presence. On a preview, `VITE_CONVEX_URL` is in the client bundle (`window.__convexUrl`), so "anyone with the Convex URL" = "anyone who can load the preview app." They can call the mutations directly, bypassing the Vercel `x-testing-auth` entirely.
- Data-exposure severity is LOW (ephemeral preview, no PII/creds/product data) — DON'T over-rate that.
- BUT the real risk is **CI integrity**: these feed the merge-blocking `e2e` gate (`getStatus`), and main auto-deploys to prod on merge. An unauthenticated `markResult`/`claimNext` = forced **false-green** = a broken PR passes the gate. That is a prod consequence regardless of data sensitivity.
- **Recommendation that won the OPEN QUESTION:** add a `secret` arg to the Convex fns, compared to a secret in the *Convex* preview env (reuse TESTING_ENDPOINT_SECRET, forwarded by the Vercel fn). Cheap defense-in-depth; closes the direct-to-Convex bypass + false-green.

**Other reusable checks for these endpoints:** validate any value that flows back to the shell runner (`flowPath` → `maestro test "$flow"`) at the Convex boundary with a strict allowlist (`^\.maestro/flows/[A-Za-z0-9._/-]+\.yaml$`, no `..`); bound array-insert args (`seedQueue` flows.length); never `echo`/`set -x` the curl that carries `x-testing-auth`; keep `commands-*.json` excluded from uploaded artifacts.

**NEO-49 WIRED-CODE re-audit (2026-06-08):** the design recs landed — `secret` arg on every fn + `assertAuthorized` fails closed when `E2E_QUEUE_SECRET` unset (even `""` is falsy → closed); secret is header-only in run-e2e-queue.sh under `{ set +x; }`, never `-e`; gate logic `total>0 AND failed==0 AND pending==0 AND running==0 AND runner.result==success` is sound (closes empty-queue, mid-flow-death, enqueue-fail). BUT the shipped `FLOW_PATH_RE` in `convex/e2eQueue.ts:30` is `/^\.maestro\/flows\/[A-Za-z0-9._/-]+\.yaml$/` which MATCHES `.maestro/flows/../../etc/passwd.yaml` — the `..` exclusion my design note called for was NOT implemented. Shell-injection is still blocked (regex rejects space/`;`/backtick/`|`/`$`/newline AND runner quotes `"$flow"`), so this is a LOW path-traversal-read only, attacker-needs-the-secret, file-must-exist+be-valid-Maestro-YAML. Fix = add a negative lookahead / explicit `..` reject (`&& !flowPath.includes("..")`). Also noted: secret compare is plain `!==` (not timingSafeEqual) — INFORMATIONAL only (HTTPS header, no per-char oracle, high-entropy GH secret).

**Verification caveat:** the prod fail-closed guarantee reduces to "TESTING_RESET_SECRET / TESTING_ENDPOINT_SECRET absent in prod Convex + prod Vercel." A fresh worktree isn't linked to a deployment, so you can't confirm it from there — say so, and recommend `npx convex env list --prod`. Also a footgun: TESTING_RESET_SECRET now gates MULTIPLE features; setting it in prod for any reason silently opens all of them. A dedicated per-feature flag decouples them.

See [[patterns_convex_auth_boundary]] — that covers requireAdmin for signed-in operator tooling; THIS covers env-gated runner/testing endpoints where the caller is NOT a signed-in user.
