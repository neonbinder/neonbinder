---
name: reference-undefined-error-class-is-transient
description: In convex/credentials.ts an absent error_class is classified TRANSIENT, not "refused" — a stubbed failing login must set error_class explicitly or it gets the "didn't answer" copy
metadata:
  type: reference
---

`TRANSIENT_ERROR_CLASSES` in `apps/web/convex/credentials.ts` contains
`undefined` alongside `"other"` and `"timeout"`. So a login failure the
browser service did not tag falls into the NEO-281 "marketplace never
answered" bucket and gets `transientMessage`, **not** the
credentials-refused copy.

Consequence for tests: a fetch stub that returns a plain
`{ error: "Invalid credentials" }` 401 for `/login/<site>` does **not**
exercise the refused-password path. Set `error_class: "invalid_credentials"`
(or `"challenge"` / `"automated_access"` for the NEO-288 site-side bucket)
to reach the copy you mean to assert. Failure ranking, outermost first:
paused → site-side (`siteMessage`) → transient (`transientMessage`) →
refused, and `saveCredentials` rewrites only the last one into
"Could not sign in to <DisplayName>. Nothing was saved — check your
username and password and try again."

Related: [[reference_adapter_mocked_fixtures_hide_gate_divergence]]
