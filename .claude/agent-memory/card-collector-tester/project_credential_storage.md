---
name: Credential Storage Feature - Profile Page
description: Notes on the credential save/clear/test flow for marketplace profiles, tested 2026-03-12, 2026-03-13 (x2)
type: project
---

Credential storage feature implemented and reviewed on 2026-03-12. Full end-to-end tested on 2026-03-13 (twice). The /profile page has a full credential management UI for BuySportsCards and SportLots (eBay coming soon per code comment).

**Why:** Sellers need stored creds so NeonBinder can automate logins to marketplaces on their behalf (bulk listing, syncing inventory).

**How to apply:** When testing or consulting on marketplace automation features, check whether credentials are stored first — all automation flows depend on this. The credential storage is the prerequisite for any listing/sync feature.

## Architecture (verified 2026-03-13)

- Browser service runs on GCP Cloud Run (not localhost) — Convex is pointed at the Cloud Run URL of `neonbinder-browser` service in project `neonbinder` (prod) or `neonbinder-dev` (dev). Resolve at runtime: `gcloud run services describe neonbinder-browser --project=<project> --region=us-central1 --format='value(status.url)'`.
- `INTERNAL_API_KEY` is set in Convex environment (not in .env.local). Local browser service (port 8080) is NOT in the Convex request path for credential operations.
- `NEONBINDER_BROWSER_URL` in Convex = production Cloud Run URL, not localhost
- BSC uses Puppeteer (full browser login via `/login/bsc`) to extract a bearer token
- SportLots uses direct HTTP POST validation via `/login/sportlots`
- Credentials stored in GCP Secret Manager (not Convex DB) — only `hasCredentials` boolean stored in `userProfiles` table
- On page load, if `hasStoredCredentials` is true, the UI fires `getSiteCredentials` action to confirm GCP still has the data
- The `storeSiteCredentials` Convex action uses PUT `/credentials/:key` — stores without marketplace validation
- "Test Credentials" button calls `testSiteCredentials` which dispatches to `authenticateBsc` (Puppeteer) or `sportlots.testCredentials` (HTTP login)
- credKey format: `${site}-credentials-${userId}` — must match regex `^[a-z0-9]+-credentials-[a-zA-Z0-9_-]+$`
- Max input length: 256 chars, validated in Convex layer only (not at browser service layer)

## Bugs Found (2026-03-13)

### BUG 1: GET /credentials/:key returns 500 instead of 404 for missing/deleted keys
- File: `neonbinder_browser/src/services/secrets-manager.ts` lines 61-64
- Root cause: `getCredentials()` catch block wraps ALL errors as `throw new Error("Failed to retrieve credentials")`, wiping out "not found" info
- `index.ts` tries to detect 404 by checking `message.includes("not found")` but never sees it
- Impact: Convex `getSiteCredentials` still returns null correctly (checks `!response.ok`), so user-facing behavior is OK, but the 404 vs 500 distinction is lost — can't tell "key doesn't exist" from "GCP is down"
- Steps to reproduce: DELETE a credential key, then GET it → expect 404, get 500

### BUG 2: PUT /credentials/:key with invalid key format returns 500 instead of 400
- File: `neonbinder_browser/src/services/secrets-manager.ts` lines 12-16 and `index.ts` PUT handler
- Root cause: `validateKeyFormat()` throws "Invalid credential key format" but Express handler wraps it as 500 "Failed to store credentials"
- Example: key `UPPERCASE-credentials-user` fails regex but returns 500 not 400
- Impact: Clients can't distinguish bad input from server errors

### BUG 3: Browser service rate limiter ValidationError at startup (dev environment)
- File: `neonbinder_browser/src/index.ts` line 58-59 (`app.set("trust proxy", true)`)
- The express-rate-limit library throws `ERR_ERL_PERMISSIVE_TRUST_PROXY` because trust proxy=true is too broad
- Not crashing, but logged as a ValidationError on every startup — rate limit headers confirmed working in smoke tests
- Impact: Low — doesn't affect functionality but clutters logs

### BUG 4: Browser service README is severely outdated
- Still describes the old /delist endpoint, doesn't mention INTERNAL_API_KEY, credential CRUD endpoints, or BSC/SportLots login flows

## What Works (verified 2026-03-13 both sessions)

- PUT /credentials/:key — stores credentials to GCP Secret Manager (PASS)
- GET /credentials/:key — retrieves stored credentials (PASS when key exists)
- DELETE /credentials/:key — deletes credentials (PASS)
- POST /credentials/check — bulk existence check returns correct true/false per key (PASS)
- Credential overwrite (PUT on existing key) — updates correctly (PASS)
- Auth middleware — 401 on missing/wrong key, 200 with valid key (PASS)
- Missing fields validation — 400 on missing username or password (PASS)
- BSC login endpoint missing fields — 400 with clear message (PASS)
- BSC login with bad credentials returns 500 with "BSC login failed" (expected behavior given Puppeteer failure)
- POST /login/sportlots with inline username+password and bad creds returns 400 with clear error message (PASS)
- Convex action layer: storeSiteCredentials, getSiteCredentials, testSiteCredentials all registered and routing correctly (confirmed via Convex HTTP API probe)
- /profile page is Clerk-protected — unauthenticated requests get 404/redirect (correct behavior)

## Bugs Still Open (confirmed 2026-03-13 second session)

- BUG 1 confirmed still present: GET on deleted key returns HTTP 500 not 404
- BUG 2 confirmed still present: PUT with UPPERCASE key format returns HTTP 500 not 400

## UI Notes (profile page)
- The site selector dropdown (BSC / SportLots) is rendered OUTSIDE the credential card border visually
- Success message on save: "Credentials saved successfully! Your credentials have been securely encrypted and stored for BuySportsCards." — use `.contains()` not exact match in tests
- Save flow: stores creds first, then calls `updateCredentialStatus` mutation to set `hasCredentials: true` in userProfile
- Clear flow: requires two-step confirmation (button → confirm button)
</content>
</invoke>