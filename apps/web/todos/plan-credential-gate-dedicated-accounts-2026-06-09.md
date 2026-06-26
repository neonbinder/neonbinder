# Plan — dedicated test accounts for the Set Builder credential-gate flows

**Goal:** replace the slow/fragile clear-then-restore credential dance in the gate triplet
(`set-selector/admin-missing-both/bsc/sl-shows-warning.yaml`) with **dedicated, fixed-state Clerk
accounts**. The test just signs in as the right account → asserts the gate → done. No clear, no
restore, no cleanup, no marketplace login in the test.

## Why
The gate is driven by `profile.siteCredentials[].hasCredentials` from a Convex query
(`api.userProfile.getUserProfile`, read in `app/set-selector/page.tsx:20-25`) — a **stored-creds flag,
not a warm token**. So an account's credential *state* alone determines which banner shows. A
never-seeded account is permanently "both missing"; a one-platform account shows the single-missing
banner. Deterministic, read-mostly, parallel-safe.

## The three accounts (dev Clerk, `sk_test`, passwordless — sign-in via testing tokens)
| account= value | email | state | flow |
|---|---|---|---|
| `admin-no-credentials` | `dev+e2e-no-creds@neonbinder.io` | neither seeded | #16 both-missing → "BuySportsCards and SportLots" |
| `admin-bsc-only` | `dev+e2e-bsc-only@neonbinder.io` | BSC seeded only | #18 SL-missing → "SportLots" |
| `admin-sl-only` | `dev+e2e-sl-only@neonbinder.io` | SL seeded only | #17 BSC-missing → "BuySportsCards" |

**Created 2026-06-09** (dev Clerk, passwordless + verified, via Backend API with `skip_password_requirement`):
no-creds `user_3Ev678c2nMmrfwtmQMzmYFc8Fgl`, bsc-only `user_3Ev677l00rxULg8ck9PJK4LkDku`, sl-only `user_3Ev677t8aPlnrIaPwRgUI9GX6Au`.
**REQUIRED + done:** `publicMetadata.role="admin"` set on all 3 — `/set-selector` is behind `AdminLayout` which redirects non-admins to `/dashboard` (the existing `dev+e2e-N` accounts have it too). Any future credential-gate test account needs this.

Single shared accounts (not per-worker): the flows only READ the gate, and the partial-seed is
idempotent (`seedMyTestCredentials` skips re-store when the secret already matches), so concurrent
workers don't clobber. **These accounts skip the `/testing/reset` step** — they have no per-test state
to reset, and reset is what would let concurrent workers clobber each other.

## Credential seeding per account (the only nuance)
`hasCredentials` lives in **per-PR-fresh Convex**, so the partials need their one platform's flag set
on each fresh preview. Drive it off the `account=` value in the sign-in → seed redirect:
- `admin-no-credentials` → seed **nothing** (skip `/testing/seed-credentials` entirely, or pass `sites=[]`).
- `admin-bsc-only` → `seedMyTestCredentials({ sites: ["buysportscards"] })`.
- `admin-sl-only` → `seedMyTestCredentials({ sites: ["sportlots"] })`.

`seedMyTestCredentials` already accepts a `sites` arg (`convex/testing.ts:98`); `/testing/seed-credentials`
currently calls it with no arg (always both). The partial seed sets `hasCredentials` via
`updateSiteCredentialStatus` (`convex/userProfile.ts:113-153`) — note it currently runs through
`storeSiteCredentials`, which does a marketplace login (fast once #44 lands BSC HTTP login; ~3-4s).
**Open option:** a test-only "set `hasCredentials` without the marketplace login" path would make the
partial seed instant and login-independent — decide during security review.

## Change surface (from the Explore map)
1. **`api/auth/testing.ts:25-32`** — add the three values to `TEST_ACCOUNTS` + the `TestAccount` type.
2. **`api/auth/testing.ts:45-52`** — `resolveTestEmail`: map each account → its `ADMIN_*_TEST_EMAIL` env var.
3. **`app/testing/sign-in/page.tsx`** — for these accounts, build the redirect to skip `/testing/reset`
   and pass the right `sites` (or skip seed) to `/testing/seed-credentials`.
4. **`app/testing/seed-credentials/page.tsx:43`** — accept a `sites` param and forward it to `seedAction`.
5. **Env vars** — `ADMIN_NO_CREDENTIALS_TEST_EMAIL`, `ADMIN_BSC_ONLY_TEST_EMAIL`, `ADMIN_SL_ONLY_TEST_EMAIL`
   in `.env.local`, Vercel Preview scope, and CI. (Singletons; no per-worker index.)
6. **Rewrite the 3 flows** to sign-in-and-assert (~10 lines each; drop the clear/restore/cleanup +
   the `clear-then-setup-*` sub-flow calls). Delete the now-unused cleanup machinery from these flows.
7. **Provision the 3 Clerk users** (this plan creates them via the Backend API).

## Security review asks (security-auditor)
- The `account=` allowlist still rejects unknown values (no arbitrary-account sign-in).
- These accounts are **test-only**, gated by the same `TESTING_ENDPOINT_SECRET` + dev/preview-only flags
  as the existing `main`/`new-profile` accounts; never reachable in prod.
- The partial-seed path must not weaken the credential-storage security model; if we add a
  "flag-only, no-login" seed, it must be auth-scoped (own profile only) + test-gated.
- No new secret exposure; the dedicated accounts hold only dev test creds (same as existing accounts;
  note all dev e2e accounts already share one BSC seller).

## Sequencing
Accounts can be created now (benign empty Clerk users). Code changes land **after** security-auditor
signs off + after #44 (so the partial seed is fast). #16 (no-creds) needs no seeding and can ship first.

## Security verdict (2026-06-09) — APPROVED WITH CONDITIONS
Risk LOW; rides on the existing 6-layer testing gate. Locked decisions:
1. **Partial seed uses the real `seedMyTestCredentials({ sites: [...] })` store path — NOT a flag-only
   helper.** This avoids the one MEDIUM risk entirely (no new flag-only surface) and is already audited
   safe; it's fast once #44 lands BSC HTTP login (~3-4s). (A flag-only helper would only be allowed as a
   NEW `TESTING_RESET_SECRET`-gated, auth-scoped, boolean-only function — we're not building it.)
2. **The 3 new `ADMIN_*_TEST_EMAIL` vars are scoped to Vercel Preview + Development ONLY — never
   Production** (same as `DEV_*`/`TESTING_RESET_SECRET`). This is what keeps the prod-fail-closed property.
3. **The 3 gate flows stay strictly sign-in-and-assert — no profile-mutating action** (no save/clear),
   since they share accounts + skip `/testing/reset`. Hard constraint.
4. New emails come ONLY from the new server env vars (never a request field) — keep the closed
   enum→server-env mapping in `resolveTestEmail`.

**Separate follow-up (pre-existing, NOT introduced here):** `updateSiteCredentialStatus`
(`convex/userProfile.ts:180`) is a public, prod-reachable mutation that sets `hasCredentials=true`
WITHOUT verifying a Secret Manager secret exists — a latent flag-vs-storage divergence masked only by
caller discipline (every current caller stores first). Harden it independently (verify-secret-exists
before allowing `true`, or restrict the public mutation to `false`/removal). Tracked as its own item.
