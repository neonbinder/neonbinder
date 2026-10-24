---
name: seed-dev-stale-sync-status
description: E2E setup fails on a reused Convex deployment with a stale "could not be reached" notice because the reset never drains selectorSyncStatus
metadata:
  type: feedback
---

`e2e-baseline.sh reset` does not drain `selectorSyncStatus` (not in `runSetBuilderReset`'s step list). On a deployment reused across live runs (a developer's dev), a leftover sport-level "X could not be reached" row makes `setup.spec.ts` fail at `expectNoSyncFailure` even though the pause is honoured and no sync runs. CI previews are fresh, so it never shows there.

**Why:** the failure looks like a pause bug, but `npx convex logs` shows no sync action at all; the notice is persisted state.
**How to apply:** when setup fails on a notice with no matching logs, `npx convex data selectorSyncStatus`; clear with `npx convex import --table selectorSyncStatus --replace -y <empty.jsonl>` (dev only). Real fix is adding the table to the reset.
