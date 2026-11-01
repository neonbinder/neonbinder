---
name: cli-to-convex-boundary-args-pin
description: A Node CLI that calls deployed Convex functions through `npx convex run` tends to ship tests for its pure helpers and for the Convex functions, but nothing pins the JSON args it sends or how it reads the answer; convex-test ids cannot stand in for real ids either
metadata:
  type: project
---

When a script under `apps/web/scripts/**` stops shelling out to `convex export`
and instead calls `convex run <module>:<fn> <json>`, the coverage splits in two
and the seam between them is where regressions hide:

- The Convex side is tested with convex-test, the CLI side with vitest over
  pure functions, and **no test asserts the JSON the CLI sends** (field names
  such as a list of schema fields that switch a check on) or the shape it
  reads back (a missing-key refusal). An omitted or renamed arg key silently
  turns a verify into a no-op while every suite stays green.
- The CLI test file already wraps `node:child_process` with
  `vi.fn(actual.spawnSync)`. Use it: `mockImplementation` on the `npx` call,
  return a canned `{status: 0, stdout: JSON.stringify(...)}`, and assert the
  parsed argv JSON plus the exit code and message for a short answer. Prefer
  the command that reaches the Convex call without a large fixture (the
  bundle floors make `load` unreachable with the synthetic bundle; `clear` is
  not).
- **convex-test ids are `<digits><tableName>`, not Convex id strings**, so
  anything keyed on a real id's bytes (table-number discovery via
  `normalizeId`, `_id` parsing) cannot be proven in a unit test. The
  loader-side codec IS proven against real ids whenever CI runs `check` on a
  real bundle, so pin the Convex codec to the loader codec byte-for-byte and
  ask for one read-only `npx convex run` cross-check on a deployment with
  rows (scan result vs the number read off a first row) in the PR body,
  rather than accepting "CI's seed is the first exercise".

**How to apply:** for each `convex run` call site, find the test that asserts
its args; if none, the finding names the exact JSON to pin and the refusal
branch to drive with a short answer.
