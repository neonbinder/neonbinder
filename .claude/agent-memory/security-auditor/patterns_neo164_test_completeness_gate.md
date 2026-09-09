---
name: patterns-neo164-test-completeness-gate
description: How the apps/web unit-test completeness gate works and the two ways it can pass while a test file did not run — check both whenever vitest.include.mjs, the verifier, or test:unit changes
metadata:
  type: project
---

`apps/web` has a CI gate (NEO-164) that turns "vitest printed passed but a test
file never ran" into a failed run: `test:unit` = `vitest run … --reporter=json
--outputFile=.vitest-results.json && node scripts/verify-test-completeness.mjs`.
Expected = globs in `apps/web/vitest.include.mjs`; actual = `testResults[].name`
from vitest's JSON report. CI runs it only via `npm run test:unit` in the
`web-unit` job of `.github/workflows/pr-pipeline.yml`.

**Why:** the gate is merge-blocking, so a gate that passes vacuously is worse
than none — it manufactures confidence. Audit it as production code.

**How to apply:** when anything in that chain changes, re-check the two ways it
can silently pass:

1. **Tautology.** The verifier's "expected" set is globbed from the *same*
   patterns vitest collects from. A test file matching neither (e.g.
   `lib/x.test.tsx`, `components/y.test.ts`, `app/z.test.ts` — the
   extension/root pairings are narrow) is neither collected nor expected, so the
   NEO-128/NEO-141 silent-skip class survives. The fix is an intentionally
   *broader* discovery glob (`**/*.{test,spec}.{ts,tsx,mjs,…}` minus
   node_modules/dist/build) so the two sets are independent.
2. **Name-presence ≠ execution.** Vitest's JsonReporter emits an entry for every
   file task registered in state, `status:"passed"` when nothing in it failed —
   including a file collected but never executed, and the zero-test stubs
   `cancelFiles` synthesises. Run state is `hasFailed(modules) ? 1 : 0`, and an
   unresolved module is not "failed". Verified: emptying one file's
   `assertionResults` still prints "✓ 82/82" and exits 0. Hardening =
   also require ≥1 assertionResult per file and `numPendingTests === 0` /
   `success === true`.

Already verified safe and not worth re-deriving: `.vitest-results.json` carries
no env vars, no console logs and no coverage map (only paths, test titles and,
on failure, stacks) and no workflow uploads it as an artifact; the verifier is
strictly read-only (readFileSync + globSync, no exec/write/network); missing
file, malformed JSON, absent/non-array `testResults`, and zero-match globs all
exit 1. Also note `npm run test:unit -- <arg>` appends the arg to the
*verifier*, not vitest — it fails loudly, but confusingly.
