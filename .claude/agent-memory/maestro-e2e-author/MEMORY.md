# Maestro E2E Author — Agent Memory Index

Non-markdown helpers: `tools/` (ParseFlow.java: offline parse of every flow)

## Feedback (hard rules)
- [Never diagnose timing first](feedback_never_diagnose_timing_first.md) — never blame timing/flake or raise a timeout; read the artifacts
- [Never push branch Convex to shared dev](feedback_never_push_a_branch_convex_to_shared_dev.md) — no `convex dev`/`deploy` to unblock a run
- [Never stage when told not to commit](feedback_never_stage_when_told_not_to_commit.md) — delete with plain `rm`; a sibling's commit sweeps the index
- [No secrets via env](feedback_no_secrets_via_env.md) — marketplace creds via `-e` leak into public CI artifacts
- [Speaking conch: one local run](feedback_speaking_conch_run_serialization.md) — one Maestro run per machine; take the lock
- [No hand-made anchor for marketplace rows](feedback_no_hand_made_anchor_for_marketplace_rows.md) — never nest synced rows under a "+ Custom" row
- [Per-worker data isolation](patterns_per_worker_data_isolation.md) — CI runners share a queue; every write is worker-scoped

## Harness, driver and runs
- [Offline flow parse harness](reference_offline_flow_parse_harness.md) — Maestro's own YAML reader, all flows in ~2s
- [Maestro web driver primitives](reference_maestro_web_driver_primitives.md) — CdpWebDriver ground truth from source
- [Maestro web getNodeText](reference_maestro_web_getnodetext.md) — how DOM nodes become `text` (input values)
- [Maestro web tap reliability](reference_maestro_web_tap_reliability.md) — tap failure classes, incl. the CDP null crash
- [pressKey and popovers](patterns_maestro_web_presskey_and_popovers.md) — Enter only; re-find by XPath
- [Native select option taps](patterns_native_select_option_taps.md) — options appear only while open
- [Native select commit + sync preempts custom](reference_native_select_commit_and_entitycolumn_sync_preempts_custom.md) — two CI-only races
- [Disabled is unreadable on web](patterns_disabled_is_unreadable_on_web.md) — `enabled:` matches nothing; prove by no-op tap
- [Prove focus by what Enter does](patterns_prove_focus_by_what_enter_does.md) — no focus attribute on web
- [Input primitive has no resource-id](patterns_input_primitive_has_no_resource_id.md) — tap the label text instead
- [Auto id shadows aria-label](patterns_auto_id_shadows_aria_label.md) — `useId()` on a labelled node; fix in product
- [eraseText needs the caret at the end](patterns_erase_text_needs_the_caret_at_the_end.md) — Backspaces at the caret
- [Test value vs placeholder](patterns_test_value_must_not_overlap_placeholder.md) — empty input reads its placeholder
- [Runtime names need regex escaping](patterns_runtime_names_need_regex_escaping.md) — `text:` is a full-match regex
- [No `$` inside `${…}`](patterns_no_dollar_inside_a_script_template.md) — the script never runs
- [childOf uses the FIRST parent](patterns_childof_parent_is_first_match.md) — `index:` for same-named pairs
- [Negative `index:` is bottom-most](patterns_negative_index_is_bottom_most.md) — `-1` = last real row
- [Heading-only via `above:` a label](patterns_heading_only_via_above_field_label.md) — leftOf/rightOf are left-edge only
- [Flow `name:` is a directory name](patterns_flow_name_is_a_directory_name.md) — keep under ~200 bytes
- [takeScreenshot paths + nested env](patterns_screenshots_and_nested_env.md) — no absolute paths; env is inherited
- [Guard-then-tap is a TOCTOU](patterns_guard_then_tap_toctou.md) — two reads 0.33s apart
- [Branch on copied button text](patterns_branch_on_copied_button_text.md) — copyTextFrom + `when: true:`
- [Operator switch branching](patterns_operator_switch_branching.md) — read PAUSED_PLATFORMS; `-e` → evalScript → `when: true:`
- [Dead-branch guards can cover a 2nd outcome](patterns_dead_branch_guards_can_cover_a_second_outcome.md) — enumerate before deleting
- [Non-matching `runFlow when` costs ~6.6s](reference_wizard_drain_loop_one_footer_guard.md) — one footer guard per loop
- [Seed drain loop waits per row](project_local_seed_times_budget.md) — `times:` is a guard, not a budget
- [Bare maestro needs Chrome for Testing](patterns_bare_maestro_needs_chrome_for_testing.md) — probe flows
- [Capture browser console with CDP](patterns_capture_browser_console_with_cdp.md) — Maestro records none
- [E2E pick selector modes](patterns_e2e_pick_selector_modes.md) — a bare selector is a TAG
- [Local Vite serves one worktree](patterns_local_vite_serves_one_worktree.md) — check the Vite cwd first
- [Check dev function-spec first](patterns_check_dev_function_spec_before_local_run.md) — a missing function reads as a missing selector
- [Local validation needs a PR preview](project_local_validation_needs_a_pr_preview.md) — new Convex functions
- [CI Convex preview starts empty](reference_ci_convex_preview_starts_empty.md) — no dev clone
- [CI seed resets the preview under you](reference_ci_seed_resets_the_preview_under_your_local_run.md) — local runs die mid-flight
- [Unstyled launch = failed stylesheet](patterns_unstyled_launch_is_a_failed_stylesheet.md) — raw-HTML PNG; full rerun
- [Credential seeding](patterns_credential_seeding.md) — fake creds for forms, seed-credentials for real auth
- [URL redirect chains](patterns_url_redirect_chains.md) — nested `?redirect=` sign-in chains

## Scrolling, viewport and the hierarchy
- [centerElement is one-sided](patterns_center_element_is_one_sided.md) — UP > 0.3H, DOWN < 0.7H; scroll to each row
- [Below-the-fold asserts](patterns_below_the_fold_asserts_and_bottom_locked_scrolls.md) — assertVisible lies past y=629
- [Inner scroller clip is invisible](patterns_inner_scroller_clip_is_invisible_to_maestro.md) — pruned by viewport only
- [sr-only in an unpositioned scroller](patterns_sr_only_in_unpositioned_scroller.md) — stuck at its scrollTop-0 spot
- [Closed `<details>` is in the hierarchy](patterns_closed_details_content_is_in_the_hierarchy.md) — open it first
- [Touch swipe scrolls a dialog body](patterns_touch_swipe_scrolls_a_dialog_body.md) — start/end swipes only
- [Virtualized list phantom rows](patterns_virtualized_list_phantom_rows.md) — overscan rows read 100% visible
- [Scroll authority disagreement](reference_scroll_authority_disagreement.md) — stale coords; default direction is DOWN
- [Clamp then anchor-restore](patterns_clamp_then_anchor_restore_after_a_panel_swap.md) — gate on a mount-only element
- [Tall client panel: re-enter the page](patterns_tall_client_panel_reenter_page.md) — re-drill after a run ledger
- [Cannot scroll after base picker](patterns_maestro_web_cannot_scroll_after_base_picker.md) — headless frame stall
- [Binder header + in-place form scroll](reference_binder_header_pointerevents_and_inplace_form_scroll.md) — near-top taps work; no footer zone
- [Card drawer sticky header swallows taps](patterns_card_drawer_sticky_header_swallows_taps.md) — assert passes, tap misses
- [Guard a tap at a footer button's x](patterns_guard_a_tap_at_a_footer_buttons_x.md) — clipped rows hit Save
- [Hierarchy dumps list portals LAST](patterns_hierarchy_dump_portals_come_last.md) — never `head` a dump
- [Columns row clip + late collapse](patterns_columns_row_clip_and_late_collapse.md) — negative-x cards
- [Selected column collapses to a card](patterns_selected_column_collapses_to_card.md) — search box and list gone
- [Search box is not a content signal](patterns_search_box_is_not_a_content_signal.md) — gate on the listbox
- [Syncing panel leaves the viewport](patterns_syncing_panel_leaves_viewport_under_a_growing_list.md) — false "done"
- [Cross-document back is bfcache](reference_cross_document_back_is_bfcache.md) — remount via NavLink + back

## Assertions and forensics
- [Negative asserts pass on a dead page](patterns_negative_asserts_pass_on_a_dead_page.md) — pair with a positive
- [Present in failure dump = arrived late](patterns_present_in_failure_dump_means_late_arrival.md) — after the last poll
- [Draft echo is not a read-back](patterns_draft_echo_is_not_a_read_back.md) — reload, read a query node
- [Exact-match proof is the demoted create](patterns_exact_match_proof_is_the_demoted_create.md) — `Create player X anyway`
- [Asserting spatial order](patterns_asserting_spatial_order.md) — candidate/anchor recipe, reference line
- [Assert a sequential run's finished state](patterns_stop_a_sequential_run_at_a_named_item.md) — never the running heading
- [Sync summary is not a UI surface](patterns_sync_summary_is_not_a_ui_surface.md) — counts never render
- [Diff optional branches green vs red](patterns_diff_optional_branches_green_vs_red.md) — SKIPPED→COMPLETED = fixture changed
- [Measure a fixture from CI artifacts](patterns_measure_a_fixture_from_ci_artifacts.md) — tap lines, convex-logs
- [Probe a fixture without draining it](patterns_probe_a_fixture_without_draining_it.md) — raw CDP, pinned Chrome
- [Flake runtime forensics](reference_flake_runtime_forensics.md) — runtime proof, not elimination
- [Moving-target tap forensics](reference_moving_target_tap_and_hierarchy_forensics.md) — target moved under the click
- [Modal nav stacking + rerun forensics](reference_modal_nav_stacking_trap_and_rerun_forensics.md) — NEO-80 occlusion
- [Toast assert after Enter](reference_toast_assert_after_enter_flake.md) — a harness miss, not a save regression
- [Resilient column give-up signature](reference_resilient_column_gaveup_signature.md) — "Add custom <Level>" not found
- [Bound a backend stall with the create gate](patterns_bound_a_backend_stall_with_the_create_gate.md) — time it across runners
- [Heavy-write saturation vs blanket stall](patterns_heavy_write_saturation_vs_blanket_stall.md) — ~1s polling floor
- [Connection lost = socket reconnect](reference_convex_connection_lost_is_a_socket_reconnect.md) — client rejects in-flight actions
- [Same-text search legs go stale](patterns_convex_same_text_search_legs_go_stale.md) — two search reads, one query
- [Placeholder pair-count forensics](reference_placeholder_pair_count_forensics.md) — count too high = two inserters

## Fixtures and data
- [Pick a fixture-owned name by name](patterns_pick_a_fixture_owned_name_by_name.md) — never "the first row"
- [Real-person names collide](patterns_real_person_fixture_names_collide_with_committed_checklists.md) — `Create` demoted to `Open`
- [Splitting a flow over shared data](patterns_splitting_a_flow_over_shared_real_data.md) — measure write sets first
- [Title fixture arithmetic](patterns_title_fixture_arithmetic.md) — run the real generator
- [Sets sync is year-wide, populated-gated](reference_sets_sync_is_year_wide_and_populated_gated.md) — no re-sync once populated
- [All Brands holds the one-sided sets](reference_all_brands_manufacturer_chicken_and_egg.md) — BSC sets no SL brand claims
- [Marketplace twin names + public search](reference_sportlots_twin_names_and_public_search.md) — ` (#<id>)` suffixes
- [Wizard fixture lookup throughput](reference_wizard_fixture_lookup_throughput.md) — ~0.7 rows/s live
- [NEO-214: no seeded fixture](reference_neo214_no_seeded_fixture.md) — Admin Tools panel gone
- [NEO-248 SL-set wizard fixture (disproven)](reference_neo248_wizard_fixture_via_attached_sl_set.md) — SL-only fetch never reaches the wizard
- [NEO-284 team-alias fixture](reference_neo284_team_alias_fixture.md) — Rickwood set, Homestead Grays
- [PlayerIds only on real cards](reference_playerids_only_real_cards_and_drawer_scroll.md) — plus drawer scroll gotchas

## Set builder selectors
- [util-drill-to-custom](patterns_util_drill_to_custom.md) — one search path per level; Level 4 guard
- [Entity column shapes + cold sync](patterns_entity_column_shapes_and_cold_sync.md) — when the search input appears
- [Custom form replaces the list](reference_entitycolumn_custom_form_replaces_list.md) — not an overlay
- [NEO-219 confirm surfaces](reference_neo219_confirm_surfaces.md) — two Enters for custom entry
- [Base mapping picker paths](reference_base_mapping_picker_paths.md) — BaseSetPicker / BaseMappingForm
- [NEO-334 title is its kind](reference_neo334_sub_variants_column_is_role_gated.md) — column 7 only under Insert; refusals
- [NEO-334 Insert › Base pair](reference_neo334_title_kind_and_insert_base_pair.md) — the "Base" insert is not the Base
- [NEO-239 retire custom](reference_neo239_retire_custom_flow_impact.md) — no Custom badge; per-side resolvability
- [NEO-155 admin section + anchor](reference_neo155_admin_section_and_setbuilder_anchor.md) — panel subtitle is the page-loaded gate
- [NEO-237 All Brands view + Unknown](reference_neo237_all_brands_view_and_unknown.md) — pinned entry aria
- [NEO-294 known brands + move](reference_neo294_known_brands_and_move_control.md) — `Move to another brand`
- [NEO-277 set-level Team row](reference_neo277_set_level_team_row.md) — `Add set team`; × saves nothing
- [NEO-300 Group Parallels multi-select](reference_neo300_grouping_multi_select.md) — `Select <row>`, `N selected`
- [NEO-306 SL review + Make insert of…](reference_neo306_sl_review_and_insert_door.md) — `Name for <label>`
- [NEO-325 Base check selectors](reference_neo325_base_check_selectors.md) — toggle never flips
- [Typed feature controls](reference_typed_feature_controls_neo71_74.md) — League/Era selects
- [toggleOptions pills](reference_toggleoptions_pills_maestro.md) — Autographed / Short Print
- [Write-once snapshots (panel)](reference_write_once_feature_snapshots_neo71_74.md) — auto-populate asserts
- [Card-level snapshot (drawer)](reference_card_level_feature_snapshot_assertability.md) — card inherits the snapshot
- [Cross-release import modal](reference_cross_release_import_modal_picker.md) — one level at a time

## Checklist, cards and the wizard
- [NEO-102 attention walker](reference_neo102_card_attention_walker.md) — badge, `N need you` pill, MissingTeamFixer
- [NEO-335 Tidy up this set](reference_neo335_teams_on_cards_section.md) — post-name steps, teams-line selectors
- [NEO-216 card drawer autosave](reference_neo216_card_drawer_autosave.md) — no Save/Cancel
- [CardDetailPanel pickers + autotitle](reference_carddetailpanel_pickers_and_autotitle.md) — NEO-25 pickers
- [Quick-add TeamPicker](reference_quick_add_form_teampicker_neo208.md) — NEO-208
- [Quick-add PlayerPicker](reference_quick_add_player_picker.md) — create/pick handles; drawer read-back
- [NEO-220 wizard only from a real fetch](reference_neo220_wizard_only_from_real_fetch.md) — only inserts-1996-score reaches it
- [NEO-92 entity review wizard](reference_neo92_entity_review_wizard.md) — replaced the checkbox list
- [NEO-92 career team entry](reference_neo92_career_team_entry.md) — chip assert, persisted-state gap
- [NEO-248 career entry years (fixed)](project_neo248_career_team_entry_years_lost.md) — years survive the New Team hop
- [NEO-236 team location split](reference_neo236_team_location_split.md) — New Team dialog
- [NEO-236 wizard teams-first walk](reference_neo236_wizard_teams_first_walk.md) — teams before players
- [Wizard headings include career teams](patterns_wizard_headings_include_staged_career_teams.md) — not a checklist club
- [Wizard decided list + batch resume](reference_wizard_decided_list_and_batch_resume.md) — read back via Back
- [Multi-team row needs a team count](patterns_multi_team_row_needs_a_team_count.md) — "A, B" is ambiguous
- [NEO-307 League combobox](reference_neo307_league_combobox.md) — `id: "League"`; Search all teams
- [NEO-331 team picker ranking](reference_neo331_team_picker_ranking.md) — 4 tiers; pick MLB
- [NEO-255 one-marketplace surfaces](reference_neo255_one_marketplace_surfaces.md) — no Match Cards
- [NEO-90 BSC team enrichment](reference_neo90_bsc_team_enrichment_e2e.md) — queue unreachable from E2E
- [NEO-91 SL badge + virtuoso wall](reference_neo91_sl_badge_and_virtuoso_bottom_open_wall.md) — bottom-open list

## Other pages
- [/admin/teams reachability](reference_admin_teams_selects_are_unreachable.md) — `team-league` untappable
- [NEO-240 league management](reference_neo240_league_management_selectors.md) — counter gate
- [NEO-313 sport switch](reference_neo313_sport_switch_selectors.md) — one-key typeahead
- [Player Management counter reflow](reference_player_management_counter_reflow.md) — "Add player" slides
- [NEO-141 credentials panel](reference_neo141_credentials_panel_states.md) — 3 panel states; seeding is a live login
- [Clerk APIKeys selectors](reference_clerk_apikeys_component_selectors.md) — /profile/api-keys
- [NEO-118 shipping labels](reference_neo118_shipping_labels_selectors.md) — label→input mapping
- [NEO-147 spine label designer](reference_neo147_spine_label_designer.md) — /print/spine-label
- [NEO-170 placeholder pipeline](reference_neo170_placeholder_pipeline_page.md) — run view
- [NEO-175 fast/heavy split](reference_neo175_fast_heavy_split_flows.md) — placeholder flows
