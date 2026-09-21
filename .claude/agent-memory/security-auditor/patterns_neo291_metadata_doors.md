---
name: patterns-neo291-metadata-doors
description: NEO-291 retired client-authored isInsert/isParallel; the durable audit rules are that a "no public mutation takes this object any more" comment is a grep target (every arg use of the shared `selectorOptionFields.metadata` validator), that a field with two write doors needs one shared normalizer, and that a new public mutation without a registry entry is a finding even when the diff is otherwise clean
metadata:
  type: project
---

NEO-291 (2026-09-20) made `metadata.isInsert` / `isParallel` DERIVED at row
creation and on `applyParallelGroupings` level moves (`convex/variantRole.ts`,
reading the parent's `isBase` or its `variant`-tagged BSC slot id, never
`row.value`), deleted `updateSelectorOptionMetadata`, narrowed
`storeReconciledOptions`' `metadata` to `{ cardNumberPrefix? }`, and added
`setSelectorOptionCardNumberPrefix` (admin, single-key, `""` deletes).

**Traps found at audit:**
1. A doc comment claiming "no public mutation takes this whole object from a
   client any more" was false: `setVariantTypePlatformData` still took
   `metadata: selectorOptionFields.metadata` and spread-merged it, so an admin
   client could send `{ isBase: false }` and strip the base role. Rule: when a
   ticket claims to close a door, grep every `args` use of the SHARED
   validator (`selectorOptionFields.metadata`, `selectorOptionMetadataFields`)
   and every `args.metadata` / `item.metadata` read, not just the file the
   ticket names. No caller or test sent it, so deleting the arg was free.
2. The same field written by two doors with two rules: the dedicated mutation
   refused control/zero-width chars and >32, the reconciliation relink/insert
   path only trimmed. Rule: one shared normalizer, called on every path.
3. The new public mutation had no entry in `publicFunctionAuth.test.ts` /
   `publicFunctionAuthGuards.test.ts` and neither file was in the diff.

**What held:** all touched mutations `requireAdmin`; derivation reads
marketplace ids only inside the creation/level-move boundary; rows with and
without marketplace ids share one code path (no flag = fail closed); the
client projects stored metadata down to the one admitted key before
forwarding (narrowing a `v.object` arg is a runtime "Unexpected field" break
that tsc does not catch).

**How to apply:** any ticket that retires a client-authored field: grep the
shared validator's arg uses, check every remaining write path for the field
shares one normalizer, and require the registry entry in the same PR.
