---
name: flow-name-is-a-directory-name
description: A flow's `name:` becomes a debug DIRECTORY name (TestDebugReporter.createFlowDir); over 255 BYTES Linux throws "File name too long" and the flow dies before command one with no screenshot — keep names under ~200 bytes ("—" and "…" cost 3 each)
metadata:
  type: reference
---

Maestro 2.8.0 creates `maestro-report/debug/<flow-file>/<flow name>/` for every
flow (`maestro.cli.report.TestDebugReporter.createFlowDir`, called from
`TestSuiteInteractor.runFlow`). Linux (CI) refuses any single path component
over **255 bytes**, so a long `name:` throws `java.nio.file.FileSystemException:
… File name too long` BEFORE the first command runs.

What the failure looks like: the flow's `maestro.log` stops right after
"Running flow …", there is no screenshot, no `commands.json`, and the junit
just says failed. The stack trace is only in the runner's own log
(`maestro-report-runner-N/logs/runner-N.log`). macOS (APFS) allows 255 UTF-8
chars rather than bytes, so a name that fails in CI can pass locally.

**Rule:** keep `name:` under ~200 bytes, counting UTF-8 — `—`, `…`, `’`, `›`
are 3 bytes each. Put the claims in the header comment, not the name. Check
the suite with a one-liner over `name:` lines (`len(n.encode())`).

Paid for on NEO-306 (CI run 36164550212): a merged flow's 417-byte name.
Related: [[offline-flow-parse-harness]] (it parses the YAML but does not
create the directory, so it cannot catch this).
