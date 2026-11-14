---
name: pw-step-timings-live-in-the-blob-report
description: Per-expect step timings for a CI spec come from the pw-report blob zip's report.jsonl, not results.json; pair with convex-logs for server-side phases
metadata:
  type: reference
---

To back a wait budget with a measurement, `pw-report-<project>-<shard>-a1` holds `report/results.json` (only test.step and axe steps, no expects) and `report/blob/report-*.zip`, whose `report.jsonl` has every step: `onTestBegin` (testId, result.startTime), `onStepBegin` (step.id, title, startTime, parentStepId) and `onStepEnd` (step.id, duration). Top-level steps (no parentStepId) are the spec's own expects and actions, in order. Test titles come from `onProject` suites. A spec's shard moves between runs, so download every shard's report and filter by title.

Server-side phases come from `convex-logs-<project>-<shard>-a1` (gzip JSONL: identifier, executionTimestamp in epoch seconds, executionTime, logLines with `adapter_sync_call` duration_ms). Align on the test's startTime. See [[convex-log-tracing-by-request-id]].

**How to apply:** a budget above 7 s quotes the sample count, the date range and the max, and says which branch (warm or cold) each sample was. Use only runs after the last change to the service being timed.
