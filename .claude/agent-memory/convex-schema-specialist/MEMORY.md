# Convex Schema Specialist — Agent Memory Index

- [Staging tables scope per operator](staging-tables-scope-per-operator.md) — selectorOption-keyed staging rows also need createdByUserId in the index; shared sets mean concurrent operators
- [Entity-review skips are per-set](entity-review-skip-is-per-set.md) — entityReviewSkips keys on selectorOptionId+kind+name on purpose; a global skip list would suppress real players
- [Root apps/web tsc is not a gate](apps-web-root-tsc-is-not-a-gate.md) — `tsc -p .` is red at baseline (~39 errors); the real gate is `tsc -p convex/tsconfig.json`
