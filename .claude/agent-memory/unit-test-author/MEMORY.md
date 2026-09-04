# Unit Test Author — Agent Memory Index

- [project_vitest_projects_setup.md](project_vitest_projects_setup.md) — Vitest 4 multi-project config: convex-lib (node/edge-runtime) + components (happy-dom); focus/activeElement pattern; deps added in NEO-39
- [project_convex_test_patterns.md](project_convex_test_patterns.md) — convex-test: call `internal.*` mutations/actions directly, spy on structured console.log lines, deterministic staleness via db.patch, proving a server re-diff vs a same-value write
- [feedback_adversarial_pass_patterns.md](feedback_adversarial_pass_patterns.md) — where real gaps hide in an already-well-tested feature: join-connector dangling in word-boundary cuts, pure fns inside .tsx with no dedicated test file, cross-ticket registry tie-breaks, whitespace-only vs empty-string
- [feedback_batch_mutation_same_row_staleness.md](feedback_batch_mutation_same_row_staleness.md) — a batch OCC mutation that bumps its own workingVersion map mid-loop falsely marks every later decision on the same row "stale"; a UI payload-shape test is not proof the backend handles that payload
