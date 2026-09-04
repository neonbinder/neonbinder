---
name: entity-review-skip-is-per-set
description: entityReviewSkips is keyed per (selectorOptionId, kind, nameNormalized) on purpose — never make the skip list global
metadata:
  type: project
---

`entityReviewSkips` (NEO-212) records names an operator decided are NOT an
entity, so junk on a checklist (header rows, "CHECKLIST", sponsor text) stops
re-entering the entity-review wizard on every re-fetch of a set. Index:
`by_selector_option_and_kind_and_name` on
`["selectorOptionId", "kind", "nameNormalized"]`.

**Why:** the skip key is deliberately scoped to ONE set. The junk that warrants
a skip is an artifact of one marketplace checklist's formatting, and a name that
is noise on one set is very often a real player on another. A global skip list
would let one operator's judgement on one set silently suppress a real player
everywhere — unrecoverable without an audit trail nobody would think to check.
`kind` is in the key because a name can be junk as a player while still being a
valid team on the same set.

**How to apply:** if anyone proposes "dedupe the skip list globally" or
"drop selectorOptionId from the index since names repeat", push back — the
per-set scope is the safety property, not redundancy. Also note the contrast
with [[staging-tables-scope-per-operator]]: `entityReviewQueue.createdByUserId`
scopes *reads* per operator, but `entityReviewSkips.skippedByUserId` is
audit-only and deliberately does NOT scope reads — a skip is a fact about the
set's data, so it applies to every operator who fetches that set afterwards.
