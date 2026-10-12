# Convex Schema Specialist — Agent Memory Index

- [Apps web root tsc is not a gate](apps-web-root-tsc-is-not-a-gate.md) — `npx tsc --noEmit -p .` in apps/web is red at baseline (153 errors on 2026-09-08; the count drifts — 39 in Aug, 65 on 2026-09-04); the real typecheck gate is `npm run…
- [Entity review skip is per set](entity-review-skip-is-per-set.md) — entityReviewSkips is keyed per (selectorOptionId, kind, nameNormalized) on purpose — never make the skip list global
- [Feedback no local convex deploy from worktrees](feedback_no_local_convex_deploy_from_worktrees.md) — Never run convex dev/deploy from a feature worktree; validate schema changes via tsc + the PR's isolated Convex preview
- [Patterns service derived field validators](patterns_service_derived_field_validators.md) — Convex validator rule for this repo — columns written from an external service response get loose validators, columns our own code produces get unions; plus the return…
- [Project neo170 placeholder batch schema](project_neo170_placeholder_batch_schema.md) — NEO-170 placeholder batch pipeline — the three-table design (placeholderJobs/Images/Pairs), its load-bearing invariants, and the review findings from 2026-08-17
- [Project neo21 cross release home set](project_neo21_cross_release_home_set.md) — NEO-21 cross-release cards — cardChecklist.selectorOptionId is the immutable "home"/printed-in pointer; guest appearances go in the cardCrossListings junction table
- [Reference typecheck convex changes](reference_typecheck_convex_changes.md) — How to typecheck apps/web/convex changes — which tsconfig matters, the known-failing baseline, and getting deps into a fresh worktree
- [Staging tables scope per operator](staging-tables-scope-per-operator.md) — Per-selectorOption staging tables must be scoped by operator (createdByUserId), because multiple admins sync the same shared set concurrently
- [Strict returns drift is invisible to typecheck](strict-returns-drift-is-invisible-to-typecheck.md) — whole-doc `returns` copies refuse at runtime, not compile; convex-test validates returns, so test every reader; or strip a derived copy in the public helper
- [Transient side-table checklist](transient-side-table-checklist.md) — a table keyed on a selectorOptions/cardChecklist id must join the reset steps (4 toEqual blocks), the delete sweep, holdings note, ops doc and the subtree-wipe graph
- [Convex has two transaction budgets](convex-two-transaction-limits.md) — a .collect() is 1 system op, not N; get this right before sizing any chunk or page
- [Per-row cost hides in entity helpers](convex-per-row-cost-hides-in-entity-helpers.md) — findTeamsByFullName is 2-18 ops, so one player create is ~28; the call site lies
- [OCC read set is the third budget](convex-occ-read-set-is-the-third-budget.md) — collect/take cost their read set; a short take is an open interval; status-flips are phantoms; fix = query selects, mutation point-reads
- [Sync Sets artefacts key per scope](sync-sets-artefacts-key-per-scope.md) — sync runs per manufacturer too; per-year array docs overflow 1 MiB; measure with getConvexSize
- [Armed backfill models have no cursor](armed-backfill-models-have-no-cursor.md) — facet/brand-unknown backfills are one take(SCAN_LIMIT+1); 16 MiB read is the real bound; page + action loop
- [Re-key action is not a backfill](rekey-action-is-not-a-backfill.md) — rekeyEntityNames resyncs only key-changed rows; steady state writes nothing; fill a new derived field with a small armed backfill
- [convex-test search is not the backend](convex-test-search-is-not-the-backend.md) — harness search = insertion order, every-term prefix, unchecked filterFields; typecheck gates filter fields
- [Tightening a validator shared with stored drafts](tightening-a-validator-shared-with-stored-drafts.md) — args+returns shared validators tighten only in the handler; required args make auth tests vacuous; reset runs after deploy
