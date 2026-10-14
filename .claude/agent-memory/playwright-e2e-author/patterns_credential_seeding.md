---
name: patterns-credential-seeding
description: How credential specs work post-NEO-29 — fake creds for form coverage, /testing/seed-credentials for real-auth coverage, needsReauth fixture and its restore
metadata:
  type: project
---

See GUIDE "Worker-state seeding" for the authoritative table of
`/testing/seed-credentials` and its `sites` values. Patterns on top of it:

## Credential FORM specs
- Type fake literals (`e2e-fake-user` / `e2e-fake-pass`); no real secrets.
- Assert `Credentials were saved ... authentication failed` after saving (not a
  success message).
- The `hasCredentials` flag is set to true before auth is attempted, so the Clear
  Credentials lifecycle still works.

## Real-auth specs
- Enter with `signIn("/testing/seed-credentials?redirect=/profile")` (the inner
  `?` stays literal; a nested `&` is written `%26`), never by typing credentials.
- Assert the success text (`BSC account authenticated successfully` or
  `Credentials saved successfully`, or the SportLots equivalent).
- Restore by routing through `/testing/seed-credentials?redirect=/profile`.

## Worker bootstrap
The `bootstrap` project (`tests/profile/worker-bootstrap.spec.ts`) resets then
seeds its shard's account. No credential typing; everything is server-side.

## `needsReauth` fixture and its cleanup (verified 2026-09-14)
- Flag a worker's OWN row by navigating to `/testing/needs-reauth?site=sportlots&redirect=<dest>`
  (sets only `needsReauth`/`needsReauthSince`; `hasCredentials` untouched, so the
  Set Builder still renders and the reauth notice shows above its heading).
- Cheapest restore: `/testing/seed-credentials?sites=sportlots&redirect=/profile/credentials`.
  On the renewable-session branch `seedMyTestCredentials` writes `needsReauth:
  false` through `updateSiteCredentialStatus`: ~1 s, no login. (An older comment
  claimed re-seeding preserves the flag; it does not, corrected in NEO-278.)
- Prove the restore landed with `Connected to SportLots` on the SL tab: that card
  renders only when the row has credentials AND is not flagged.
- The reauth notice's dismissal is `sessionStorage` per tab: click its link BEFORE
  Dismiss, because Dismiss hides the whole strip (link included) for the tab
  session; get back to the Set Builder with a fresh navigation.
