---
name: cross-sport-player-resurfaces-on-resync
description: a player created in the wizard with "Sport for this name" != the set's sport is NOT found by the re-sync resolve gate, so his name comes back as a new-player row; a "teams-only re-sync" spec cannot assume every name is known
metadata:
  type: project
---

`resolveUnknownsAndStartBatch` (convex/selectorOptions.ts) resolves each printed
name through `players.resolveNameForReview` -> `sameNamePlayers`, which reads
only `(name, the SET's sport)` plus that sport's `playerSports` rows. A player
created (or linked) under another sport is invisible to it, so on a re-sync his
name is "unknown" again and the wizard opens on a "New player" row for him
(Step 1 of N+2 instead of a teams-only Step 1 of 2).

**Why:** found diagnosing NEO-426's red re-sync step (spec expected "Step 1 of 2",
got "Step 1 of 3"; the extra step was the Non Sport player). Pre-existing, not a
step-counter bug.

**How to apply:** a spec that asserts a teams-only re-sync review must not leave a
cross-sport player on the set's cards, or must account for his row. Check the
failure screenshot's step title ("New player") before suspecting the counter.
