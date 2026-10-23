---
name: patterns-neo358-collector-rows-pin-catalog
description: NEO-358 real collection — per-user copy rows that GUARD catalog deletes/moves make every signed-in account a catalog-freeze lever; the ownership shape that held; JSON-cursor index clamp
metadata:
  type: project
---

NEO-358 added `collection.ts` (per-user copies, signed-in) and
`collectionCatalog.ts` (signed-in read of the whole NB catalog via
`lib/catalogView.ts`, field-by-field projection, pinned by a FORBIDDEN_KEYS
JSON-text test).

What held (re-check on any edit):
- `ownerId` is never an argument; every read uses an owner-prefixed index and
  every write that names a row goes through `ownCopy` / `resolveHome`, which
  answer "not found" identically for missing and not-yours.
- URL ids arrive as `v.string()` and are `normalizeId`d to null/empty.
- All 24 public functions pinned in `publicFunctionAuth.test.ts`.

The durable trap: a user-owned row that BLOCKS an operator path. A copy of a
card refuses `deleteCard`, blocks parallel rebuilds and wipes, and
`moveCards` refuses whole above `MAX_COPIES_PER_MOVE`. Any signed-in account
(sign-up is open unless Clerk says otherwise) can therefore freeze catalog
maintenance with `addHaves` (200 cards/call) or line items with distinct notes.
**How to apply:** whenever a per-user table gains a guard on an admin/catalog
write, ask (1) is there a per-owner total cap, (2) does a count-capped refusal
let one user cross the cap alone, (3) can the operator see/act on it without
the user. Link [[patterns-wikidata-pool-abuse-surface]].

Client-built JSON cursors: `Number.isInteger` admits negatives; a
`while (index < list.length)` loop seeded from it spins until the runtime
kills the query. Clamp to `[0, length)` at parse.
