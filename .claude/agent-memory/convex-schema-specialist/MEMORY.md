# Convex Schema Specialist — Agent Memory Index

- [Apps web root tsc is not a gate](apps-web-root-tsc-is-not-a-gate.md) — `npx tsc --noEmit -p .` in apps/web is red at baseline (153 errors on 2026-09-08; the count drifts — 39 in Aug, 65 on 2026-09-04); the real typecheck gate is `npm run…
- [Entity review skip is per set](entity-review-skip-is-per-set.md) — entityReviewSkips is keyed per (selectorOptionId, kind, nameNormalized) on purpose — never make the skip list global
- [Feedback no local convex deploy from worktrees](feedback_no_local_convex_deploy_from_worktrees.md) — Never run convex dev/deploy from a feature worktree; validate schema changes via tsc + the PR's isolated Convex preview
- [Patterns service derived field validators](patterns_service_derived_field_validators.md) — Convex validator rule for this repo — columns written from an external service response get loose validators, columns our own code produces get unions; plus the return…
- [Project neo170 placeholder batch schema](project_neo170_placeholder_batch_schema.md) — NEO-170 placeholder batch pipeline — the three-table design (placeholderJobs/Images/Pairs), its load-bearing invariants, and the review findings from 2026-08-17
- [Project neo21 cross release home set](project_neo21_cross_release_home_set.md) — NEO-21 cross-release cards — cardChecklist.selectorOptionId is the immutable "home"/printed-in pointer; guest appearances go in the cardCrossListings junction table
- [Reference typecheck convex changes](reference_typecheck_convex_changes.md) — How to typecheck apps/web/convex changes — which tsconfig matters, the known-failing baseline, and getting deps into a fresh worktree
- [Staging tables scope per operator](staging-tables-scope-per-operator.md) — Per-selectorOption staging tables must be scoped by operator (createdByUserId), because multiple admins sync the same shared set concurrently
- [Strict returns drift is invisible to typecheck](strict-returns-drift-is-invisible-to-typecheck.md) — whole-doc `returns` copies (teams.ts, entityReviewQueue.ts) refuse at runtime, not compile; grep `_id: v.id("<table>")` before handing back
- [Transient side-table checklist](transient-side-table-checklist.md) — a table keyed on a selectorOptions id must join the reset steps (4 toEqual blocks), the deleteSelectorOption sweep, the holdings note and the ops doc
- [Convex has two transaction budgets](convex-two-transaction-limits.md) — a .collect() is 1 system op, not N; get this right before sizing any chunk or page
- [Per-row cost hides in entity helpers](convex-per-row-cost-hides-in-entity-helpers.md) — findTeamsByFullName is 2-18 ops, so one player create is ~28; the call site lies
- [OCC read set is the third budget](convex-occ-read-set-is-the-third-budget.md) — collect/take cost their read set; a short take is an open interval; status-flips are phantoms; fix = query selects, mutation point-reads
