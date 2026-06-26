# Maestro E2E Author — Memory Index

- [feedback_no_secrets_via_env.md](feedback_no_secrets_via_env.md) — Never pass BSC/SportLots secrets via Maestro `-e`; use seed-credentials server-side instead
- [patterns_credential_seeding.md](patterns_credential_seeding.md) — URL redirect chain and fake-creds patterns for credential flows post-NEO-29
- [patterns_url_redirect_chains.md](patterns_url_redirect_chains.md) — Sign-in redirect chain patterns: sign-in → reset → seed → destination
- [patterns_per_worker_data_isolation.md](patterns_per_worker_data_isolation.md) — HARD RULE: suite runs parallelism=3 (3 concurrent users); selectorOptions/cardChecklist are GLOBAL. Every flow uses a PER-WORKER custom set under Baseball/2024; NEVER edit a shared real set concurrently. Only 2 flows touch real 2024 Topps Chrome (read marketplace data + add one feature), both tagged `isolated`
- [patterns_util_drill_to_custom.md](patterns_util_drill_to_custom.md) — util-drill-to-custom.yaml: general 6-level drill (real+custom uniform); per-level search-vs-add algorithm; return contract; Variant Types no-scroll rule; team-picker now uses it
- [feedback_speaking_conch_run_serialization.md](feedback_speaking_conch_run_serialization.md) — 🐚 HARD RULE: wait for the conch (lock dir) before any maestro run; hold it ONLY for that one run; release the instant it ends (before analysis); re-acquire per run; SYNCHRONOUS only, never run_in_background/monitors (2026-06-10 cascade incident)
