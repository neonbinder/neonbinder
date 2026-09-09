# Puppeteer Security Engineer — Agent Memory Index

- [Bsc b2c login secret discipline](feedback_bsc_b2c_login_secret_discipline.md) — Secret-handling rules specific to the BSC B2C fetch login — which fields are secret, what may/may not be logged or returned
- [Neo141 credential rework browser half](project_neo141_credential_rework_browser_half.md) — NEO-140/141 — user passwords are no longer stored; the canary secrets are the ONLY exception, and `reauth_required` is a cross-repo monitoring contract
- [Puppeteer cleanup invariant in services/browser](project_puppeteer_cleanup_invariant.md) — Every adapter.login() call must be wrapped in try/finally with adapter.cleanup() in route handlers, or Cloud Run OOMs after ~10 requests
- [Secret version keep one](project_secret_version_keep_one.md) — NEO-115 decision — credential secrets keep exactly ONE Secret Manager version; keep-2/history was considered and rejected, don't re-propose it
- [Bsc b2c http login](reference_bsc_b2c_http_login.md) — BSC login is browser-free over fetch via Azure AD B2C custom policy (B2C_1A_signin); the exact OIDC flow, public client config, and where it can break
- [Credential key format and ratelimit](reference_credential_key_format_and_ratelimit.md) — Credential-key format ($site-credentials-$userId), where it's validated vs. where the rate-limiter keys on it, and why per-key rate limiting is the correct model behin…
- [Usps letter tracking behavior](reference_usps_letter_tracking_behavior.md) — How a USPS First-Class letter actually behaves in EasyPost tracking — terminal status, scan count, code length, misleading first message. Ground truth for tracker fixt…
