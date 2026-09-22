# Puppeteer Security Engineer — Agent Memory Index

- [Bsc b2c login secret discipline](feedback_bsc_b2c_login_secret_discipline.md) — Secret-handling rules specific to the BSC B2C fetch login — which fields are secret, what may/may not be logged or returned
- [Neo141 credential rework browser half](project_neo141_credential_rework_browser_half.md) — NEO-140/141 — user passwords are no longer stored; the canary secrets are the ONLY exception, and `reauth_required` is a cross-repo monitoring contract
- [Puppeteer cleanup invariant in services/browser](project_puppeteer_cleanup_invariant.md) — Every adapter.login() call must be wrapped in try/finally with adapter.cleanup() in route handlers, or Cloud Run OOMs after ~10 requests
- [Secret version keep one](project_secret_version_keep_one.md) — NEO-115 decision — credential secrets keep exactly ONE Secret Manager version; keep-2/history was considered and rejected, don't re-propose it
- [Bsc b2c http login](reference_bsc_b2c_http_login.md) — BSC login is browser-free over fetch via Azure AD B2C custom policy (B2C_1A_signin); the exact OIDC flow, public client config, and where it can break
- [Credential key format and ratelimit](reference_credential_key_format_and_ratelimit.md) — Credential-key format ($site-credentials-$userId), where it's validated vs. where the rate-limiter keys on it, and why per-key rate limiting is the correct model behin…
- [Usps letter tracking behavior](reference_usps_letter_tracking_behavior.md) — How a USPS First-Class letter actually behaves in EasyPost tracking — terminal status, scan count, code length, misleading first message. Ground truth for tracker fixt…
- [BSC B2C session model](bsc-b2c-session-model.md) — refresh window is absolute 24h; rememberMe SSO cookie + prompt-less /authorize is the way past it; SL has no expiry at all
- [require.cache fake for a singleton client](reference_require_cache_fake_for_singleton_client.md) — a module-level lazy SDK client captures the first spy; the fake constructor must delegate per call
- [undici socket reuse and close](reference_undici_socket_reuse_and_close.md) — global fetch does not keep back-to-back requests on one socket (pool race, use withSingleConnection); an unconsumed body >16 KiB hangs Client.close()
- [Which paths exercise a cold BSC password login](reference_which_paths_exercise_a_cold_bsc_password_login.md) — transient creds + the canary are the ONLY callers of the B2C password exchange; a sub-second BSC login is cache/refresh, never proof sign-in works
- [Secret Manager has no upsert](reference_secret_manager_has_no_upsert.md) — every credential write is a check-then-create race; ALREADY_EXISTS and NOT_FOUND are both fall-throughs, never a lock or a retry
