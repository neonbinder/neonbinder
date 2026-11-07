---
name: review-gate-cost-is-the-sequential-name-loop
description: The checklist review gate makes one action-to-query round trip per name, so a 200-name insert costs about 5 s on CI before any feature adds to it
metadata:
  type: project
---

`resolveUnknownsAndStartBatch` calls `players.resolveNameForReview` once per name, in sequence. On CI that alone makes a 200-300 name gate 4.6-6 s, measured the same with and without NEO-424's set-history scan (which adds about 0.3 s and 256 docs). The "Kept all N cards" notice shows when the gate starts.

**Why:** a spec holding the wizard to the 7 s budget right after that notice has under 2 s of headroom on a big insert, so a short deployment-wide slowdown turns it red. The shared wizard helper still waits 60 s there, which hides this.

**How to apply:** before blaming a feature for gate time, break the gate down from the Convex logs by phase against a same-size gate on a main run. A plan that needs real headroom batches the name loop into sliced queries, as `findSkippedEntityNames` already does.
