---
name: patterns-neo322-initials-key-rekey
description: NEO-322 initials join in the shared entity-name key + the armed rekeyEntityNames action; the key is no longer idempotent under re-normalisation, initials now equal the short word they spell, and the collision policy is only safe while readers branch on list size
metadata:
  type: project
---

Shared key (`lib/entities/normalize-name.ts`) joins runs of 2+ single-letter
tokens BEFORE the token sort. Two durable consequences to check on any later
change to that chain or its callers:

1. **Not idempotent.** Two NON-adjacent lone initials sort next to each other,
   so `n("J. Doe K.") = "doe j k"` but `n("doe j k") = "doe jk"`. Any site that
   feeds a STORED key back through the normaliser (or through a helper that
   normalises its input, e.g. `findTeamsByExactName`) looks up a different key.
   Grep for re-normalised keys whenever the chain changes; look up by the raw
   name or query the index with the key directly.
2. **Initials equal the word they spell.** "A. L. Smith" = "Al Smith",
   "T. Y. Cobb" = "Ty Cobb", "J. R. Smith" = "Smith Jr.". Exactly-one paths
   (checklist commit `sameNamePlayers` length 1, findOrCreate) link silently.
   Product precision call, not a code bug; surface it, do not block on it.

Re-key action shape (sibling of splitTeamLocations / NEO-214): internal*
only, env flag asserted first in the one write mutation, confirm phrase only
in the action (applyPage directly via `convex run` skips the phrase and the
plan-complete gate; the live stable-holder check still guards leagues).
Collision policy "written" for players/teams is sound ONLY while every
identity reader takes a list; leagues/franchises readers use `.first()` so
they must stay "skipped". Re-check reader shapes (`.first()`/`.unique()`) on
any new index reader. Ask for unit tests of the arm + a keyword pin in
publicFunctionAuth.test.ts ([[public-function-auth-registry]]).
