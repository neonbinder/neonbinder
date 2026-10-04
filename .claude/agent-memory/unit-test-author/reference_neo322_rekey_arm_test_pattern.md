---
name: reference-neo322-rekey-arm-test-pattern
description: How the armed re-key (rekeyEntityNames) tests prove "writes nothing" and cover both arm doors, plus the red-proof recipe for an armed action
metadata:
  type: reference
---

- Prove "writes nothing" by snapshotting every touched table (`ctx.db.query(t).collect()` for the main tables AND side tables) before and after, then `toEqual`; a throw/report assertion alone does not catch a half-written refusal.
- An armed internalAction + its write mutation have TWO independent arm checks. Red-prove each separately (no-op `assertRekeyArmed`, then no-op the entry point's flag branch): the first only reddens the direct-`applyPage` test, the second only the confirmed-unarmed tests. A single break would leave one door looking covered.
- ConvexError from `t.action`/`t.mutation` keeps `.data` (code, message, report); assert `toBeInstanceOf(ConvexError)` then read `.data`.
- Cheap cap tests: 21 rows for a per-table sample cap; 2*(cap+1) franchise rows for a collision-list cap run in ~1s.
- Stale-key fixtures: write the old key by hand ("c j kayfus"); side tables need parent aliases too (player.aliases + stale playerAliases row; team.aliases + stale teamAliases row).
