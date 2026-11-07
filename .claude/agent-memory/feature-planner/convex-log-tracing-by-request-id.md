---
name: convex-log-tracing-by-request-id
description: How to trace a flow through a convex-logs artifact when planning a fix for a red run: timestamp is epoch seconds, a cached query hit carries the original executionTimestamp, so follow requestId and parentExecutionId; a scheduler hop starts a new requestId with no parent
metadata:
  type: project
---

In a `convex-logs-*` artifact:

- `timestamp` is epoch **seconds**, not milliseconds.
- A cached query hit carries the **original** execution's `executionTimestamp`, so
  sorting by time puts it in the wrong place. Trace by `requestId` and
  `parentExecutionId` instead.
- A scheduler hop (`runAfter`, `runAt`, a cron) starts a new `requestId` with no
  parent. A cron → action → mutation chain is therefore several separate trees,
  joined only by wall-clock time and the function names they log.

**How to apply:** before a plan blames a press, a spec or a timer for a state, rebuild
the order from these fields. A row written by a scheduled run looks the same as one
written by the press unless you check which tree it belongs to.
