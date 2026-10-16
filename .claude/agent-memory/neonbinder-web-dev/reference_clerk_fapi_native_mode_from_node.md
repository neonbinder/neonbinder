---
name: clerk-fapi-native-mode-from-node
description: A Node process can hold a real Clerk session with no cookies via FAPI native mode (_is_native=1) — the client JWT rides in the Authorization header both ways; verified live in NEO-339's setbuild auth
metadata:
  type: reference
---

Headless Clerk sign-in from Node (tools/setbuild/auth/clerk-fapi.ts, NEO-339, verified live 2026-10-11 on a development instance):

1. `POST {fapi}/v1/client/sign_ins?_is_native=1&__clerk_testing_token=…`, form `strategy=ticket&ticket=<sign-in token>` → 200, `response.created_session_id`, and the **client JWT in the `Authorization` RESPONSE header**.
2. `POST {fapi}/v1/client/sessions/{sid}/tokens/convex?_is_native=1&__clerk_testing_token=…` with that client JWT sent back **raw** (no `Bearer`) as `Authorization` → `{ jwt }` with `aud: "convex"` and the `role` claim.

With a testing token on every call, the dev instance did NOT demand a dev-browser context — the `/v1/dev_browser` retry (mirrored from convex/machineAuth.ts, gated on the refusal's wording) never fired. Keep it anyway; it is cheap and Clerk's to change.

FAPI origin = base64-decode the publishable key after `pk_(test|live)_`, strip the trailing `$`.

**How to apply:** any new headless client (script, CI job, MCP) should reuse `testingTokenSource` / `machineTokenSource` rather than drive the `/testing/sign-in` page in a browser. Never put a FAPI URL in an error message — its query string carries the testing token. Related: [[convex-call-spread-hides-bad-args]].
