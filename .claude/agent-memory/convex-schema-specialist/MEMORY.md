# Convex Schema Specialist — Agent Memory Index

- [Apps web root tsc is not a gate](apps-web-root-tsc-is-not-a-gate.md) — `npx tsc --noEmit -p .` in apps/web is red at baseline (153 errors on 2026-09-08; the count drifts — 39 in Aug, 65 on 2026-09-04); the real typecheck gate is `npm run…
- [Entity review skip is per set](entity-review-skip-is-per-set.md) — entityReviewSkips is keyed per (selectorOptionId, kind, nameNormalized) on purpose — never make the skip list global
- [Feedback no local convex deploy from worktrees](feedback_no_local_convex_deploy_from_worktrees.md) — Never run convex dev/deploy from a feature worktree; validate schema changes via tsc + the PR's isolated Convex preview
- [Patterns service derived field validators](patterns_service_derived_field_validators.md) — Convex validator rule for this repo — columns written from an external service response get loose validators, columns our own code produces get unions; plus the return…
- [Project neo170 placeholder batch schema](project_neo170_placeholder_batch_schema.md) — NEO-170 placeholder batch pipeline — the three-table design (placeholderJobs/Images/Pairs), its load-bearing invariants, and the review findings from 2026-08-17
- [Project neo21 cross release home set](project_neo21_cross_release_home_set.md) — NEO-21 cross-release cards — cardChecklist.selectorOptionId is the immutable "home"/printed-in pointer; guest appearances go in the cardCrossListings junction table
- [Reference typecheck convex changes](reference_typecheck_convex_changes.md) — How to typecheck apps/web/convex changes — which tsconfig matters, the known-failing baseline, and getting deps into a fresh worktree
- [Staging tables scope per operator](staging-tables-scope-per-operator.md) — Per-selectorOption staging tables must be scoped by operator (createdByUserId), because multiple admins sync the same shared set concurrently
