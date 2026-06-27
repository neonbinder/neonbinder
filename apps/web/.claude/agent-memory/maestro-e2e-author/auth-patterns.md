---
name: Auth and navigation patterns for Maestro flows
description: How testing sign-in works, URL patterns, reusable credential setup flows, and profile page scroll anchors
type: reference
---

## Testing sign-in URL pattern
The app exposes a testing-only sign-in endpoint that bypasses Clerk bot protection:
  `${APP_URL || "http://localhost:3000"}/testing/sign-in?redirect=[destination]`

This URL is placed in the `url:` header of a flow file (not in a `launchApp` step).
After `launchApp` the browser opens this URL which signs the test user in and
redirects to `[destination]`.

## Flow header pattern for authenticated flows
```yaml
url: ${APP_URL || "http://localhost:3000"}/testing/sign-in?redirect=/some-page
name: Descriptive name
tags:
  - tag1
---
- launchApp
- extendedWaitUntil:
    visible: "Neon Binder"
    timeout: 45000
```

The `extendedWaitUntil: visible: "Profile Settings"` is the correct guard for
confirming the profile page has loaded and the user is authenticated.

DEPRECATED: `extendedWaitUntil: visible: "Neon Binder" timeout: 45000` — removed
from all flows; it is a pure UI text with no relation to credential section readiness.
Profile page load anchor is `"Profile Settings"` (h1).

## Reusable credential setup flows
Located in `neonbinder_web/.maestro/flows/profile/`:

**Idempotent helpers** (use for set-selector flows and any flow that just NEEDS creds to exist):
- `setup-bsc-credentials.yaml` — skips save if "Clear Credentials" already visible; uses BSC_USERNAME, BSC_PASSWORD
- `setup-sportlots-credentials.yaml` — skips save if "Clear Credentials" already visible; uses SPORTLOTS_USERNAME, SPORTLOTS_PASSWORD

**Destructive helpers** (use for cred-test flows that must test the full save+auth cycle):
- `clear-then-setup-bsc-credentials.yaml` — always clears then re-saves; same env vars
- `clear-then-setup-sportlots-credentials.yaml` — always clears then re-saves; same env vars

All four flows:
- Are tagged `util` (not smoke/regression — they are helpers, not standalone tests)
- Assume the browser is already on the `/profile` page
- End with the credentials saved state confirmed

CRITICAL: Calling setup-* repeatedly with the destructive variant hits BSC/SportLots login
endpoints on every call. With 10 set-selector flows × 2 platforms = 20 fresh logins per run,
this triggers rate-limiting. Always use the idempotent variant for set-selector flows.

## Pattern for flows that need credentials before navigating to a feature page

CRITICAL SCROLL ANCHOR: The profile page credential section scroll anchor is
`"BuySportsCards Credentials"` (the `<h2>` heading). Do NOT use `".*Select Platform.*"`
(the `<label>` text) — Maestro's web accessibility hierarchy sometimes misses label text
on tall pages, causing 30-second scrollUntilVisible timeouts and subsequent assertion failures.

The page-level load anchor is `"Profile Settings"` (the `<h1>` at the top of the page).

Pattern for credential setup before a feature flow:
```yaml
# Navigate to profile. setup-* flows start by scrolling to "BuySportsCards Credentials"
# so no pre-scroll is needed — just confirm the page is loaded.
- openLink: ${APP_URL || "http://localhost:3000"}/profile
- extendedWaitUntil:
    visible: "Profile Settings"
    timeout: 20000

- runFlow:
    file: ../profile/setup-bsc-credentials.yaml
    env:
      BSC_USERNAME: ${BSC_USERNAME}
      BSC_PASSWORD: ${BSC_PASSWORD}

# CRITICAL: reload /profile between BSC and Sportlots setup.
# After BSC setup completes, the page may be scrolled into the credential section.
# setup-sportlots-credentials.yaml scrolls DOWN to "BuySportsCards Credentials";
# without reloading to reset scroll position it can miss the heading above the fold.
- openLink: ${APP_URL || "http://localhost:3000"}/profile
- extendedWaitUntil:
    visible: "Profile Settings"
    timeout: 20000

- runFlow:
    file: ../profile/setup-sportlots-credentials.yaml
    env:
      SPORTLOTS_USERNAME: ${SPORTLOTS_USERNAME}
      SPORTLOTS_PASSWORD: ${SPORTLOTS_PASSWORD}

# Navigate to the actual feature page after credentials are set
- openLink: ${APP_URL || "http://localhost:3000"}/set-selector
- extendedWaitUntil:
    visible: "Set Selector"
    timeout: 15000
```

Key: the `url:` header must point to `/profile` (not the feature page) so the
browser lands on profile where the credential setup flows can do their work.
Then `openLink` takes the user to the feature page.

## Environment variables for credentials
- `BSC_USERNAME`, `BSC_PASSWORD` — BuySportsCards credentials
- `SPORTLOTS_USERNAME`, `SPORTLOTS_PASSWORD` — SportLots credentials
- `TEST_EMAIL`, `TEST_PASSWORD` — Clerk test user (used by the testing sign-in endpoint)
- `APP_URL` — base URL, defaults to `http://localhost:3000`

## Credential page — scroll timeouts

The profile page has a long public-profile section ABOVE the credential area.
Scrolling from the top to "BuySportsCards Credentials" takes 15-22s. Always add
explicit `timeout: 30000` to ALL `scrollUntilVisible "BuySportsCards Credentials"` steps.
Similarly use `timeout: 20000` for `scrollUntilVisible ".*Sportlots Credentials.*"` steps.

Maestro's default scrollUntilVisible timeout is insufficient for this page.

## Auth-failed banner viewport positioning

The auth-failed banner (`".*Credentials were saved.*authentication failed.*"`) renders
ABOVE the "Save Credentials" button in the DOM. If you scroll "Save Credentials" to
center (y≈315) THEN tap it, the viewport is positioned mid-page. After the tap Maestro
has no natural scroll direction to find the banner above.

CORRECT PATTERN:
1. Scroll "Save Credentials" WITHOUT `centerElement` — places button near y≈500, leaving
   form header + banner area visible ABOVE it in the viewport.
2. Tap "Save Credentials".
3. Use `extendedWaitUntil: visible: ".*Credentials were saved.*authentication failed.*"
   timeout: 120000` — NOT scrollUntilVisible. The banner is in the viewport already.
   120s timeout required: BSC fake-credential Puppeteer login + Cloud Run round-trip takes
   45-60s (not 30s).

WRONG PATTERN: `scrollUntilVisible ".*Credentials were saved.*authentication failed.*"`
after tapOn Save Credentials — scroll goes DOWN, away from the banner which rendered UP.

## Radix Button tapOn NPE — fix by centering, NOT by index

`tapOn: "Yes, Clear"` can fail with `null cannot be cast to non-null type kotlin.Int`
(Kotlin NPE): Radix `<Button>` wraps its label in an inner `<span class="rt-Text">`, and
while the button is still animating in / clipped, Maestro's text selector resolves to that
span — whose `getBoundingClientRect()` is null in CDP. The outer `<button>` has valid bounds.

FIX (NO index — our hard rule): scroll the button to center + let it settle, THEN plain
`tapOn` so the match lands on a fully-painted button with valid bounds:
```yaml
- scrollUntilVisible:
    element: { text: "Yes, Clear" }
    centerElement: true
    timeout: 15000
    waitToSettleTimeoutMs: 1000
- tapOn: "Yes, Clear"
```
This is the proven pattern in the `admin-missing-*` flows (which pass). **Do NOT use
`index: 0`** — index selection violates our no-index rule (NEO-46) and masks the real cause
(the mid-animation span match); it was reverted from `credentials-lifecycle.yaml` on
2026-06-09. If a Radix button STILL NPEs after centering + settle, give it a stable
`id:` (aria-label) and tap by `id:`. Index is never the answer.

## "Credentials cleared" wait timeout

`extendedWaitUntil: visible: ".*Credentials cleared.*"` — use `timeout: 30000`.
The BSC credential deletion backend operation takes >7s. Maestro's default 7s timeout
will fail. All four `extendedWaitUntil ".*Credentials cleared.*"` steps in lifecycle
flows need `timeout: 30000`.

## Reactive storm fix after cold login

After a cold Puppeteer login (~22s) for BSC or SportLots, the Convex reactive
subscription receives a flood of update events. This causes a React reconciliation
storm where CDP `getBoundingClientRect()` returns null for elements (even visible ones).
Even `extendedWaitUntil` may fail to register a visible element during this storm.

FIX: Before using `tapOn: "Clear Credentials"` or any tap immediately after cold login
completes, insert a full page reload:
```yaml
- openLink: ${APP_URL || "http://localhost:3000"}/profile
- extendedWaitUntil:
    visible: "Profile Settings"
    timeout: 30000
```
This discards React's in-flight state and gives a clean render from which to proceed.

## Tags convention
- `smoke` — runs on every PR; fast; happy path only
- `regression` — runs nightly / post-preview; full coverage including edge cases
- `set-selector` — feature group for set hierarchy tests
- `auth` — authentication tests
- `profile` — profile page tests
- `credentials` — credential save/clear/test flows
- `util` — reusable helper flows, not standalone test runs
