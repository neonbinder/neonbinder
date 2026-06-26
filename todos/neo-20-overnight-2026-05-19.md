# NEO-20 overnight progress — 2026-05-19

## TL;DR

**NEO-20 security goal is complete.** Marketplace auth tokens (BSC bearer, SportLots session cookie) are now reachable **only from Convex backend functions**.

- Anonymous traffic to the browser service Cloud Run (dev + prod) returns 403 across every endpoint (verified by anonymous `curl` to `/sites`, `/credentials/foo/token`, even `/health`).
- All token-returning Convex actions (`getSiteToken`, `getBscToken`, `authenticateBsc`, `authenticateSportlots`) are `internalAction` — no Convex RPC client can reach them.
- Convex authenticates to the browser service via Google OIDC ID tokens (`neonbinder-convex` SA, audience = Cloud Run URL). The shared `INTERNAL_API_KEY` is retired from the browser path; runtime SA no longer has secret accessor on it.
- `neonbinder.io` is up (200 OK).

There was a ~2-hour window where prod was broken (02:36Z → 03:24Z UTC) between the terraform apply that removed `allUsers` and the apply that created `convex_invoker`. **Convex prod could not call prod browser service during that window.** Prod recovered automatically once `convex_invoker` landed — no code-level intervention required from users.

## PRs merged (chronological)

| # | Repo | Title | Merged | Effect |
|---|---|---|---|---|
| 14 | ioc | pre-grant browser-service invoker to Convex SA — NEO-20 (1/2) | 00:23Z | Add `convex_invoker` to dev tf state. Apply failed first attempt (drift). |
| 15 | ioc | stop racing the deploy workflow on Cloud Run spec | 01:09Z | Add container.resources + minScale/maxScale to ignore_changes. Apply succeeded, `convex_invoker` finally landed on dev. |
| 34 | convex | lock down BSC/SportLots tokens — NEO-20 | 01:21Z | Demoted 4 actions to internalAction. Added OIDC helper. Transitional dual-auth (both headers). |
| 31 | browser | require Cloud Run IAM auth — NEO-20 | 01:21Z | Removed `requireInternalAuth`. cloudbuild deploys with `--no-allow-unauthenticated`. Smoke test rewritten for ID token auth. |
| 16 | ioc | remove allUsers + INTERNAL_API_KEY env — NEO-20 (2/2) | 02:08Z | Destroys landed, env removal failed on 409. |
| 17 | ioc | ignore container env on browser Cloud Run | 02:18Z | Added env to ignore_changes. Dev tf state finally clean. |
| 18 | ioc | release: propagate NEO-20 lockdown to prod | 02:36Z | Develop→main. Destroys landed on prod. `convex_invoker` creation failed on a NEW 409 trigger (container_concurrency). **Prod broken starts here.** |
| 20 | ioc | hot-fix prod 409 by ignoring container_concurrency | 03:14Z | Added container_concurrency to ignore_changes. Dev no-op. |
| 21 | ioc | release: NEO-20 hotfix — propagate to prod | 03:24Z | Develop→main hotfix. `convex_invoker` finally created on prod. **Prod recovered.** |

## PRs opened and closed (deferred)

| # | Repo | Status | Reason |
|---|---|---|---|
| 36 | convex | closed | Cleanup — drop transitional `x-internal-key` fallback. E2E showed 5 flow failures (3 admin-missing-creds, 2 checklist). The convex preview lookup returned `PreviewNotFound`, suggesting Vercel preview is wired to **prod** Convex rather than a per-PR Convex preview, so the test environment differs from what the assertions expect. Worth a morning look with fresh context. The fallback is functionally harmless: browser service ignores `x-internal-key`. |

## Verification done

- **Negative test (prod):** `curl -sS -o /dev/null -w "%{http_code}" https://neonbinder-browser-117170654588.us-central1.run.app/{sites,credentials/foo/token,health}` → all `403`.
- **Negative test (dev):** Same on `https://neonbinder-browser-xxlo66yxuq-uc.a.run.app/...` → `403`.
- **Positive test (dev):** `convex-dev-gate` (full Maestro E2E suite) green on browser deploy run 26070324083.
- **Positive test (prod):** `prod-login-probe`, `prod-smoke`, `prod-promote` all green during the browser deploy. Live `convex_invoker` confirmed via tf apply log on run 26074226384.
- **Site availability:** `https://neonbinder.io/` → HTTP 200, ~1s response, redirects to `www.neonbinder.io`.

## Known follow-ups

1. **Reopen #36 (cleanup x-internal-key fallback).** Two paths to investigate:
   - Is the Vercel preview deployment supposed to use a per-PR Convex preview or share prod's? If sharing prod's, the 5 e2e failures are environment-specific, not auth-related.
   - Triage the actual failing flows (`admin-missing-bsc-shows-warning.yaml` etc.) by reading the Maestro debug output — what UI state does the screenshot show after the "Clear Credentials" tap?
2. **Clear `INTERNAL_API_KEY` env on both Convex deployments.** Per `feedback_no_direct_convex_commands.md`, must go through `npm run deploy:dev` / `npm run deploy:prod`. Browser side no longer reads it; Convex side won't read it either after #36 lands.
3. **Pre-existing terraform drift** on dev/prod Cloud Run services (cpu format `"2000m"` vs `"2"`, container_concurrency 80 vs 3 on prod, minScale annotation removed externally). Already absorbed into `ignore_changes` via #15/#17/#20. If you want terraform to actually own these values again, the deploy workflow must stop overriding them.
4. **NEO-21 (suggested by security audit):** the preprocess service is now the lowest-hanging fruit — still `allUsers` invoker, still uses `INTERNAL_API_KEY` header check. Same OIDC-migration pattern would apply.

## Files modified this session (live in `~/workspace/neonbinder-worktrees/`)

- `neonbinder_web/convex/credentials.ts` — internalAction conversion, OIDC helper, http→https loopback guard, transitional dual-auth
- `neonbinder_web/convex/adapters/buysportscards.ts` — internalAction for `getBscToken`, removed `requireAdmin`, rerouted callers through `internal.*`
- `neonbinder_web/convex/adapters/sportlots.ts` — rerouted to `internal.credentials.getSiteToken`
- `neonbinder_web/package.json` — added `google-auth-library@^9`
- `neonbinder_browser/src/index.ts` — removed `requireInternalAuth` middleware + `timingSafeEqual` import
- `neonbinder_browser/cloudbuild.yaml` — `--no-allow-unauthenticated`
- `neonbinder_browser/tests/credentials-routes.test.mjs` — dropped in-process auth mirror + 401 cases
- `neonbinder_browser/tests/smoke.test.mjs` — rewrote for `SMOKE_TEST_ID_TOKEN` + 403 expectations
- `neonbinder_terraform/main.tf` — added `convex_invoker`, removed `public_access` + `runtime_api_key_access`, removed `INTERNAL_API_KEY` env block, added container resources/annotations/env/concurrency to browser service `ignore_changes`

## Worktree cleanup needed

Several worktrees can be removed once you've reviewed them in the morning:

```
~/workspace/neonbinder-worktrees/
├── neonbinder_terraform-neo-20-step1/                       — branch merged (#14)
├── neonbinder_terraform-neo-20-lock-down-auth-tokens/       — superseded by step2 fresh branch
├── neonbinder_terraform-neo-20-unblock-apply/               — branch merged (#15)
├── neonbinder_terraform-neo-20-step2/                       — branch merged (#16)
├── neonbinder_terraform-neo-20-stop-env-drift/              — branch merged (#17)
├── neonbinder_terraform-neo-20-ignore-concurrency2/         — branch merged (#20)
├── neonbinder_web-neo-20-lock-down-auth-tokens/             — branch merged (#34)
├── neonbinder_browser-neo-20-lock-down-auth-tokens/         — branch merged (#31)
└── neonbinder_web-neo-20-drop-fallback/                     — branch on closed #36, keep for reopen
```

Cleanup command: `git worktree prune` in each parent repo.
