# Maestro E2E Author — Memory Index

- [feedback_no_secrets_via_env.md](feedback_no_secrets_via_env.md) — Never pass BSC/SportLots secrets via Maestro `-e`; use seed-credentials server-side instead
- [patterns_credential_seeding.md](patterns_credential_seeding.md) — URL redirect chain and fake-creds patterns for credential flows post-NEO-29
- [patterns_url_redirect_chains.md](patterns_url_redirect_chains.md) — Sign-in redirect chain patterns: sign-in → reset → seed → destination
- [patterns_per_worker_data_isolation.md](patterns_per_worker_data_isolation.md) — HARD RULE: suite runs parallelism=3 (3 concurrent users); selectorOptions/cardChecklist are GLOBAL. Every flow uses a PER-WORKER custom set under Baseball/2024; NEVER edit a shared real set concurrently. Only 2 flows touch real 2024 Topps Chrome (read marketplace data + add one feature), both tagged `isolated`
- [patterns_util_drill_to_custom.md](patterns_util_drill_to_custom.md) — util-drill-to-custom.yaml: general 6-level drill (real+custom uniform); per-level search-vs-add algorithm; return contract; Variant Types no-scroll rule; team-picker now uses it
- [patterns_virtualized_list_phantom_rows.md](patterns_virtualized_list_phantom_rows.md) — virtuoso overscan rows read as 100% visible and steal taps; anchor with `below:` (top-edge compare + distance sort); maestro-web emits NO node for a bare <input type=checkbox>
- [project_local_validation_needs_a_pr_preview.md](project_local_validation_needs_a_pr_preview.md) — a flow using a BRANCH-ONLY Convex fn can't run locally: shared dev lacks it, no deploy key, `convex deploy` = PROD. Check `npx convex function-spec | grep <fn>` first
- [feedback_speaking_conch_run_serialization.md](feedback_speaking_conch_run_serialization.md) — 🐚 HARD RULE: wait for the conch (lock dir) before any maestro run; hold it ONLY for that one run; release the instant it ends (before analysis); re-acquire per run; SYNCHRONOUS only, never run_in_background/monitors (2026-06-10 cascade incident)
- [Local Vite serves ONE worktree](patterns_local_vite_serves_one_worktree.md) — check the :3000 process cwd; run your own on :3001 with VITE_DEV_DISABLE_HTTPS=1 + APP_URL
- [Negative asserts pass on a dead page](patterns_negative_asserts_pass_on_a_dead_page.md) — an error-boundary page satisfies every notVisible; always follow one with a positive assert
- [Card drawer's sticky header swallows taps](patterns_card_drawer_sticky_header_swallows_taps.md) — assertVisible passes under it; pin the drawer to max scroll then correct back down ~157px
- [Title fixture arithmetic](patterns_title_fixture_arithmetic.md) — esbuild-bundle the generator and CALL it; a flow's PLAYER_NAME goes to Card name, never into the title
- [Column shapes + cold sync](patterns_entity_column_shapes_and_cold_sync.md) — search input needs >8 entries; an EMPTY column shows `Sync <X>` before the sync starts, so gate on the `Syncing <X>` panel
- [Bare `maestro test` needs SE_BROWSER_PATH](patterns_bare_maestro_needs_chrome_for_testing.md) — otherwise branded Chrome gives a 1x1 viewport and every assert "fails"
