---
name: patterns-credential-seeding
description: How credential flows work post-NEO-29 — fake creds for form coverage, seed-credentials for real-auth coverage
metadata:
  type: project
---

## Credential FORM flows (Group A)
Files: `profile/clear-then-setup-bsc-credentials.yaml`, `profile/clear-then-setup-sportlots-credentials.yaml`, `profile/setup-bsc-credentials.yaml`, `profile/setup-sportlots-credentials.yaml`, `profile/save-bsc-credentials.yaml`, `profile/save-sportlots-credentials.yaml`.

- Use `inputText: "e2e-fake-user"` and `inputText: "e2e-fake-pass"` — no real secrets.
- Assert `".*Credentials were saved.*authentication failed.*"` after saving (not `".*Credentials saved successfully.*"`).
- The `hasCredentials` flag is set to true before auth is attempted, so Clear Credentials lifecycle still works.
- `runFlow` callers do NOT pass any `env:` for credentials.

## Real-auth flows (Group B)
Files: `profile/test-bsc-credentials.yaml`, `profile/test-sportlots-credentials.yaml`.

- Sign-in URL uses seed-only chain: `.../testing/sign-in?redirect=/testing/seed-credentials?redirect=/profile&worker=...`
- Assert `".*BSC account authenticated successfully.*|.*Credentials saved successfully.*"` (or SportLots equivalent).
- Restore by routing through `/testing/seed-credentials?redirect=/profile` (no runFlow typing).

## Worker bootstrap (Group C)
File: `profile/worker-bootstrap.yaml`.

- Uses reset-then-seed chain: `.../testing/sign-in?redirect=/testing/reset?redirect=/testing/seed-credentials?redirect=/profile&worker=...`
- No runFlow credential blocks — everything is server-side.

## Set-selector flows (Group D)
- Top-level `url:` gets seed-only chain added: `...?redirect=/testing/seed-credentials?redirect=<destination>&worker=...`
- All `runFlow env:` blocks that forward `BSC_*`/`SPORTLOTS_*` are removed.
- `util-login-to-bsc` and `util-login-to-sportlots`: removed the `setup-*-credentials` runFlow step entirely; kept only the "Test Credentials" tap and real-success assertion.

## Auth-failed assertion string (verified from app/profile/page.tsx)
- Fake-cred path: `".*Credentials were saved.*authentication failed.*"`
- Real-auth path (BSC): `".*BSC account authenticated successfully.*|.*Credentials saved successfully.*"`
- Real-auth path (SL): `".*Sportlots account authenticated successfully.*|.*Credentials saved successfully.*"`
