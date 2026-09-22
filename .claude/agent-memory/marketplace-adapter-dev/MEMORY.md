# Marketplace Adapter Dev — Agent Memory Index

- [Eslint does not cover plain ts](reference_eslint_does_not_cover_plain_ts.md) — apps/web `npm run lint` visits no plain `.ts` file, so Convex adapters and lib/ are gated only by tsc + vitest
- [Worktree node_modules linking](reference_worktree_node_modules_linking.md) — link-deps.sh checks the repo root, not apps/web; symlink main/apps/web/node_modules by hand after cmp on the lockfile
- [Generated api.d.ts needs a hand edit in worktrees](reference_generated_api_needs_hand_edit_in_worktrees.md) — new convex module → add its two lines to `_generated/api.d.ts` when `npx convex codegen` has no CONVEX_DEPLOYMENT; V8 files cannot import "use node" files
- [Narrowing a Convex validator is a runtime break](reference_narrowing_convex_validator_is_a_runtime_break.md) — tsc stays green; grep FE forwards of stored sub-objects (modal `metadata: r.metadata`) before narrowing
- [Swept log markers are pinned](reference_swept_log_markers_are_pinned.md) — resolvabilityLogSafety.test.ts asserts exact skip/coverage log prefixes exist; keep the marker text, append detail after it
- [PRODUCT BUG tests are fix requests](feedback_product_bug_tests_are_fix_requests.md) — a red test titled "PRODUCT BUG (file:line)" is a fix for the file owner; run untracked sibling tests in the fast gate, never edit the test
- [Read budget by construction in convex-test](reference_convex_test_read_budget_by_construction.md) — Proxy over ctx.db counts reads; optional pre-read index + both paths pinned equal; t.run cannot return a Map; empty BSC list = failed side
- [convex-test needs the modules arg](reference_convex_test_needs_the_modules_arg.md) — `convexTest(schema)` alone throws a misleading `.glob is not a function` TypeError
- [Pure routers: existing rows route by the NB value](reference_pure_router_rows_carry_nb_value.md) — a holder index with ids only makes the marketplace label the only string in scope; the rename is what exposes it
- [Bulk rows in convex-test bypass the children cache](reference_convex_test_bulk_rows_bypass_children.md) — 3000-row bound tests: one t.run of direct inserts, never a seedSet that patches children each time
- [Sync action `message` is log-only](reference_sync_action_message_is_log_only.md) — legacy *Form components render it but `useEnsureSync` columns never mount them; the status row is the only surface
- [Marketplace bucket words leak into set names](reference_marketplace_bucket_words_leak_into_set_names.md) — "Other ONIT Athlete …" is stored as the NB name; start-anchored matchers miss it; fix at the adapter boundary, never widen the matcher
