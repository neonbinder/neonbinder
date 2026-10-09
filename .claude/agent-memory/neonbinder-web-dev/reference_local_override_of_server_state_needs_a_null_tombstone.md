---
name: local-override-of-server-state-needs-a-null-tombstone
description: When a dialog's local state overrides a per-row value the server also stores (a refusal, a hint), "cleared" must be a null entry, never a deleted key, or the stored value comes back
metadata:
  type: reference
---

Pattern from NEO-325 SlSetReviewModal: local `refused: Record<slId, Line | null>`
layered over the server's stored `entry.lastRefusal`. Read as
`slId in local ? local[slId] : stored`. Renaming or re-filing a line writes
`null`; deleting the key would resurrect the stored refusal that was about the
old name or target. After a save, MERGE the result's refusals into local state
rather than replacing it, so lines the save never reached (stopped part-way,
past the per-save cap) keep their tombstones.

Related reuse: `components/SetSelector/ready-title-clashes.ts` (`readyTitleClashes`)
works for any "new names in one scope must differ" list: pass each line as
`{ key, title, ownSet: true, bsc: [], sl: [] }` with no existing rows, plus a
ref-held drafts map re-rendered only when `titleClashSignature` changes.
See [[live-validation-without-keystroke-renders]].
