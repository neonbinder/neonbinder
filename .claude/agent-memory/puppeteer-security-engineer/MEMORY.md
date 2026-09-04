# Memory Index

- [project_puppeteer_cleanup_invariant.md](project_puppeteer_cleanup_invariant.md) — Every adapter.login() must be wrapped in try/finally with adapter.cleanup() in route handlers; otherwise Chromium leaks → Cloud Run OOM
- [project_tcdb_adapter_credential_free.md](project_tcdb_adapter_credential_free.md) — TCDB adapter is public/credential-free; browser lifecycle owned by module-scope scrape fns, so route-level cleanup() is an intentional no-op (don't flag it)
- [reference_usps_letter_tracking_behavior.md](reference_usps_letter_tracking_behavior.md) — real USPS letter tracker facts: `out_for_delivery` is terminal, 31-digit code, null locations, "Cancellation of Postage" means postmarked
