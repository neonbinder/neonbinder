---
name: test-unit-ignores-file-args
description: apps/web `npm run test:unit -- <files>` runs the WHOLE suite; the args land on the trailing verify script, not vitest
metadata:
  type: reference
---

`npm run test:unit` is `vitest run ... && node scripts/verify-test-completeness.mjs`, so
`npm run test:unit -- a.test.ts b.test.ts` appends the files to the verify script and vitest
runs all ~700 files (about a minute). A coordinator asking for "test:unit on the touched files"
gets the full suite either way; report it as such.

**How to apply:** iterate with `npx vitest run <files>` (fast), then run plain
`npm run test:unit` once as the gate. A red in a file another parallel builder is editing is
theirs; rerun after they settle before calling it baseline (see [[check-baseline-reds-in-main-not-by-stash]]).

Related trap from the same session: match-published-checklist fixtures numbered "C0"/"R0"
pair through the letter-prefix fallback (both strip to "0"); use bare numbers that never meet
when a test needs cards to stay unmatched.
