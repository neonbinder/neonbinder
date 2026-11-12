---
name: scratch-probe-via-sibling-test-header
description: To prove a wiring change end to end without writing the real tests, copy a sibling test file's header (everything before its first describe) into a temp convex/zz*.test.ts, add one probe test, run it, delete it
metadata:
  type: reference
---

Builders do not own new tests (unit-test-author does), but a gate or action
change should still be proven once through convex-test before the report.
The cheapest probe: take an existing test file that already mocks the right
adapters and seeds the right tree (e.g. `fetchCardChecklist.publishedChecklist.test.ts`
for the fetch, `setHistory.gate.test.ts` for the review gate), slice off
everything before its first `describe(` with a short python script, append
one `describe("scratch")`, write it to `convex/zz<Something>.test.ts`, run
`npx vitest run <file>`, then `rm` it in the same command.

**How to apply:** the file must sit under `convex/` (vitest's include and the
`import.meta.glob` modules map are relative), so delete it in the same Bash
call that runs it and `ls convex/zz*` before reporting; the worktree is shared
and the coordinator commits whatever is there. vitest swallows `console.log`
on a pass, so assert rather than print. Related: [[convex-test-needs-the-modules-arg]],
[[test-unit-ignores-file-args]].
