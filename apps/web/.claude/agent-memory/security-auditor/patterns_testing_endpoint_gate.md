---
name: patterns-testing-endpoint-gate
description: How the E2E testing sign-in / seed / reset path is gated, and the updateSiteCredentialStatus flag-vs-storage divergence risk
metadata:
  type: project
---

# E2E testing endpoint security model (neonbinder_web)

**The `account=` test-account selector path** (drives Maestro sign-in without a password):
`/testing/sign-in` (client) -> `POST /api/auth/testing` (Vercel fn) -> `lib/testing/issue-clerk-tokens.ts` -> Clerk Backend API.

Defense-in-depth on `api/auth/testing.ts`:
1. Vercel env scoping: `CLERK_TESTING_ENABLED`, `CLERK_SECRET_KEY`, `TESTING_ENDPOINT_SECRET`, `TEST_EMAIL*` set on Preview+Development only, NEVER Production.
2. Runtime `VERCEL_ENV` check -> 404 if not preview/development.
3. Shared-secret header `x-testing-auth` must equal `TESTING_ENDPOINT_SECRET` (strict compare; unset on server => all requests fail).
4. **Account allowlist** `TEST_ACCOUNTS` (`isTestAccount`) -> unknown values 400. The email is NEVER taken from the request; `resolveTestEmail` maps an allowlisted account constant to a SERVER env var. So token-minting can only ever resolve to a configured test email. Arbitrary-email sign-in is structurally impossible.
5. 120s sign-in-token TTL.
6. Audit log `event: testing_tokens_issued` (account/worker/email/ip) — but NOT the token/secret.

`issue-clerk-tokens.ts`: `testEmail` is the only email input and it comes from server env (never client). No client-controlled email reaches Clerk.

**Convex-side test mutations/actions** (`convex/testing.ts`): `resetMyTestState`, `seedMyTestCredentials`.
- Auth-scoped to `getCurrentUserId(ctx)` (caller's own rows only; no spoofable userId arg).
- Fail-closed in prod via `if (!process.env.TESTING_RESET_SECRET) throw` (var unset on prod Convex).
- Secrets read from server env (`DEV_BSC_*`, `DEV_SPORTLOTS_*`), never from client args. Returns booleans only.

## KEY FINDING — updateSiteCredentialStatus is a flag-only public mutation, NOT test-gated
`convex/userProfile.ts` `updateSiteCredentialStatus` is a PUBLIC `mutation`:
- Auth-scoped (own profile only) — GOOD.
- But it sets `profile.siteCredentials[].hasCredentials` with NO check that a real secret exists in Secret Manager, and is NOT gated by `TESTING_RESET_SECRET`. It is callable in PRODUCTION.
- The gate at `app/set-selector/page.tsx` trusts this flag alone (it is a stored-flag, not a warm token).
- Today this is safe ONLY by caller convention: `app/profile/page.tsx` and `seedMyTestCredentials` always call `storeSiteCredentials` (real store) BEFORE flipping the flag true. There is no server-side invariant binding flag=true to creds-exist.
- Implication for any new "flag-only, no marketplace login" test helper: it MUST be a separate test-gated (`TESTING_RESET_SECRET`) + auth-scoped function. Do NOT loosen `updateSiteCredentialStatus` itself, and do NOT let any flag-only path ship to prod, or a user could be shown "credentials present" while Secret Manager has nothing (gate bypass / silent failure).

`getUserProfile` query returns only `{site, hasCredentials, lastUpdated}` — no username/password. No raw-cred leak to client. GOOD.
