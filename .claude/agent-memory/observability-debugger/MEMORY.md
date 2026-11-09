# Observability Debugger — Agent Memory Index

- [Neo170 wedged batch alert](project_neo170_wedged_batch_alert.md) — PostHog placeholder_batch_wedged event + the alert to wire for stranded NEO-170 placeholder batches
- [Convex test parallel teardown flake](reference_convex_test_parallel_teardown_flake.md) — Pre-existing nondeterministic teardown noise in apps/web's convex-lib parallel unit run — not a regression
- [Sentry scrub audit surfaces](reference_sentry_scrub_audit_surfaces.md) — Surfaces no hook reaches, JSON-text regex traps, and how to prove a scrub with the real SDK and rrweb
- [Response clone cancel hangs](reference_response_clone_cancel_hangs.md) — Never await reader.cancel() on a response.clone(); the tee waits for the caller's branch
