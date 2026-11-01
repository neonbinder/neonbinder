# Observability Debugger — Agent Memory Index

- [Neo170 wedged batch alert](project_neo170_wedged_batch_alert.md) — PostHog placeholder_batch_wedged event + the alert to wire for stranded NEO-170 placeholder batches
- [Convex test parallel teardown flake](reference_convex_test_parallel_teardown_flake.md) — Pre-existing nondeterministic teardown noise in apps/web's convex-lib parallel unit run — not a regression
- [HTTP probe misses the WS sync path](reference_http_probe_misses_ws_sync_path.md) — ConvexHttpClient probes never see the Transition a useMutation awaits; Convex client verbose/onServerDisconnectError are off by default; posthog-js drops capture before init
