# Memory Index

- [project_puppeteer_cleanup_invariant.md](project_puppeteer_cleanup_invariant.md) — Every adapter.login() must be wrapped in try/finally with adapter.cleanup() in route handlers; otherwise Chromium leaks → Cloud Run OOM
- [reference_bsc_b2c_http_login.md](reference_bsc_b2c_http_login.md) — BSC login is browser-free over fetch via Azure AD B2C (B2C_1A_signin): the 4-step auth-code+PKCE flow, public client config, timings (~3s vs ~17.5s Puppeteer), and the fallback signal
- [feedback_bsc_b2c_login_secret_discipline.md](feedback_bsc_b2c_login_secret_discipline.md) — Secret rules for the BSC B2C fetch login: generic "Authentication failed" to callers, redact via buildLoginDiagnostic, log only sellerId 4-char prefix; never log cookies/csrf/code/verifier/token
- [reference_credential_key_format_and_ratelimit.md](reference_credential_key_format_and_ratelimit.md) — Credential key = $site-credentials-$userId (NOT a secret; validated by KEY_PATTERN in secrets-manager); rate limiter keys per-credential-key behind the Cloud Run IAM gate; express-rate-limit draft-6/MemoryStore facts proving no key leak/DoS
