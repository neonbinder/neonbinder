---
name: neo500-pick-list-apply-tests
description: NEO-500 sale-apply Pick List tests — truncated-read fixture with a boundary control, getDocumentSize doc-cap proof, pullOpen absent-vs-undefined check, seed hop recipe
metadata:
  type: reference
---

Files: `convex/lib/pickLines.test.ts` (pure), `convex/listingSales.pickList.test.ts` (apply/re-poll), `convex/testing.pickOrder.test.ts` (seed hop).

- **Truncated read (`take(MAX_LINES_PER_CARD + 1)`)**: add the box copy through `addLineItem` FIRST, then raw-insert MAX rows of the same card into a binder in one `t.run` (never touched, so counts don't matter). Always pair with a control at MAX-1 raw rows that flips the flag, or the "absent" assert proves nothing.
- **Distinct copy rows**: `addLineItem` with `keepsOwnLine: true` stops folding; boxes refuse slots, so patch `slot` via `t.run` for a snapshot test.
- **Doc size cap**: `getDocumentSize` from `convex/values` on a hand-built worst-case doc; also assert the uncapped shape EXCEEDS 1 MiB so the cap is shown load-bearing.
- **Cleared optional literal**: a patch with `pullOpen: undefined` removes the field — assert `"pullOpen" in doc === false` AND the `by_owner_pull_open` eq(true) read is empty.
- **Per-sale budget**: pre-insert a sale whose stored applied item holds N `from` entries, then re-poll with that line plus a new one; the re-poll matches the old line by key and applies only the new one.
- Seed hop needs the same `lib/listingSku` mock as listingSales tests (convex-test ids lack the checksum); `cardChecklist.platformData` is required — pass `{}` for a ref-less card.
- `testing.*` seeds are not pinned by name in publicFunctionAuth*.test.ts (checked NEO-500).

Related: [[project-convex-test-patterns]], [[neo322-rekey-arm-test-pattern]].
