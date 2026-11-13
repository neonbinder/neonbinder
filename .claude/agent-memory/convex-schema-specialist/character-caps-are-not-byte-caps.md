---
name: character-caps-are-not-byte-caps
description: A name capped at N characters is up to 3N bytes in Convex (JS length counts UTF-16 units); size docs, args and reads by getConvexSize with a byte cap beside every row/char cap
metadata:
  type: project
---

Repo caps (`MAX_PLAYER_NAME_LENGTH = 120`, `MAX_CARD_PLAYERS = 20`,
`MAX_CARD_TEAMS = 8`) count `string.length`, i.e. UTF-16 code units. Convex
sizes values in UTF-8 bytes, so a 120-unit name of BMP characters (e.g. "€")
is 360 bytes. Measured with `getConvexSize` (NEO-496, 2026-11-11), one
publisher-checklist row `{number, players[20], teams[8]}` at every cap is
3,583 bytes in ASCII and 10,303 bytes in 3-byte characters; a typical row is
68 bytes.

Consequence: a count cap alone does not bound bytes. 2,000 worst rows is
~20 MB, over the 16 MiB argument/return and transaction read limits, and a
"worst row ~3.5 KB" estimate is the ASCII case only.

**How to apply:** any table or wire shape that stores user/publisher text
in bulk gets a BYTE cap (measured server-side with `getConvexSize` from
`convex/values`, which also runs in the browser so the client can split
batches the same way) beside its row and character caps: per document
(chunk), per write batch, per stored unit, per read. Chunk by measured bytes,
never by row count. Measure with a throwaway `.mjs` in the scratchpad that
imports `getConvexSize` by absolute path into `apps/web/node_modules`.
Related: [[convex-two-transaction-limits]], [[sync-sets-artefacts-key-per-scope]].
