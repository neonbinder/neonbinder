---
name: wall-clock-unit-tests-red-under-load
description: Two apps/web unit tests are wall-clock bound and go red when the laptop is loaded (several sessions running); rerun them alone before suspecting a change
metadata:
  type: reference
---

Two tests in the full `npm run test:unit` measure time and fail when the shared laptop is busy. A load average of 30-40 is common when several sessions run gates at once.

- `lib/checklists/parse-published-checklist.test.ts`, "a 2 MB line-format file whose players are 'a , , , … x'": asserts < 2000 ms. It took 2.0-2.8 s under load.
- `scripts/eslint/theme-allowlist.test.mjs`, "no file outside PERMANENT carries a palette class": hits the 5 s test timeout while it scans the tree. `npm run lint` enforces the same rule and stays green.

**Why:** both went red in a merge whose diff never touched the parser or any theme file. Run alone with `npx vitest run <file>`, both passed.
**How to apply:** check `uptime` first. If the parser and its imports are unchanged (`git diff HEAD --stat` on them), rerun the file alone and report the isolated result. Never raise the bound. A red that persists when run alone with low load is real. Related: [[check-baseline-reds-in-main-not-by-stash]].
