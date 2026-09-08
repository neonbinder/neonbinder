---
name: neo141-credentials-panel-states
description: "NEO-140/141 credential rework — /profile/credentials is now connect-and-hold-a-session: exact strings for the 3 panel states + nudge, the outcome that ceased to exist, seeding is now a LIVE login (every post-seed wait must be marketplace-sized), and why a reauth_required flow is not honestly triggerable"
metadata:
  type: reference
---

Model shift: we no longer store a marketplace password. It is used once, in
flight, to mint a BSC refresh token / SportLots session cookie.

## Panel states (`app/profile/credentials/page.tsx`), in render order
1. `needsReauth` → amber card. `<strong>Sign in to {label} again</strong>` +
   "Your {label} session expired or was revoked…". Buttons: **Sign in again**,
   **Clear Credentials**. **NO "Test Credentials" button** — by design.
2. connected → `<strong>Connected to {label}</strong>` (was "Credentials saved
   for {label}"). Buttons: Sign in again / **Test Credentials** / Clear Credentials.
3. otherwise → the sign-in form. Labels `{label} Username/Email`, `{label}
   Password`; buttons **Connect** (was "Save Credentials", busy "Connecting...")
   / **Test Stored Credentials** / Clear Credentials + Cancel when connected.
Plus a nudge that renders alongside state 2 on EVERY load until a connect/test
succeeds in this browser session: `<strong>Connection not yet verified</strong>`.

`{label}` is `BuySportsCards` / `SportLots` (was "Sportlots" — casing only).

## Because only state 2 has a "Test Credentials" button
Every flow that waits on that label will burn its full timeout and then report
"button never appeared" whenever the worker is in state 1 or 3 — a misleading
failure. Gate first with `extendedWaitUntil: visible: ".*Connected to {label}.*"`
(7s). That one assert covers both bad states and names the real problem.

## Message strings that matter to assertions
- rejected connect: `Could not sign in to {label}. Nothing was saved — check your
  username and password and try again.` — assert
  `.*Could not sign in to {label}.*Nothing was saved.*`
- transport failure (do NOT let this count as a pass): `Could not reach {label}
  to verify your credentials. Nothing was saved — please try again.`
- successful connect: `Connected to {label} successfully. Your password was not
  stored — only the session it created.`
- clear: `Cleared your {label} connection.` (was "Credentials cleared successfully!")
- test success (unchanged): `BSC account authenticated successfully! Token stored.`
  / `SportLots account authenticated successfully! Session cookie stored.`

**The "credentials were saved, but authentication failed" outcome no longer
exists.** `saveCredentials` is connect-and-store: on a rejected login it stores
NOTHING and leaves `hasCredentials` untouched. The E2E replacement for that
assertion is: rejection message + the sign-in form still rendered (the form only
renders while unconnected, so it doubles as "nothing was saved" — valid only when
the flow is not in edit mode, e.g. it arrived from a cleared state).

## Seeding is now a real login — every post-seed wait is marketplace-sized
`/testing/seed-credentials` awaits `seedMyTestCredentials` before it redirects,
and that action calls `saveCredentials` (= a live sign-in, 30-65s) whenever the
stored session is not renewable (BSC refresh token lives 24h) or the username
drifted. It skips on the common path. Consequences:
- Scope every seed with `?sites=buysportscards` / `?sites=sportlots` when only
  one platform matters — an unscoped seed signs in to BOTH.
- Any wait that spans a seed redirect needs 90s+ (setup.yaml's chain: 120s).
- A flow that CLEARS a platform guarantees the next run's seed pays a full login.

## The re-auth state IS testable — via a hook added for it (2026-08-11)
Organically it is unreachable (only the browser service's `reauth_required`
sets it; the honest wait is a 24h token expiry). So NEO-141 added:
- `convex/testing.ts` → `markSiteNeedsReauth({site})` — `TESTING_RESET_SECRET`-gated,
  caller's own row only, sets `needsReauth` + leaves `hasCredentials: true`,
  returns `{updated:false}` when the caller has no entry for that site.
- `/testing/needs-reauth?site=<site>&redirect=<final>` (page + route in
  `src/main.tsx`), same shape as the `/testing/reset` and
  `/testing/seed-credentials` siblings.
- Flow: `profile/session-expired-prompts-sign-in-again.yaml` (SportLots — its
  30-day cookie means the precondition seed almost always skips its live login).

**Re-seeding does NOT clear the flag.** When the session is still renewable
`seedMyTestCredentials` skips the store and calls `updateSiteCredentialStatus`
with no `needsReauth` argument, and `reauthPatch(undefined)` returns `{}` —
deliberately preserving it. Only a successful login clears it
(`applyLoginOutcome`). Since the re-auth card has no "Test Credentials" button,
the only in-UI route to one is **"Sign in again" → the form's "Test Stored
Credentials"** (enabled because `hasCredentials` never went false), then
**"Cancel"** to leave edit mode — a successful test does NOT close the form, so
without that tap the connected card never re-renders.

Blast radius of a flag left behind by a failed run: UI-only. The Set Builder
gate (`app/set-selector/page.tsx`) keys on `hasCredentials`, and no fetch path
reads `needsReauth` — the only other casualty is `profile/test-credentials.yaml`
(SportLots half) on the same runner.
