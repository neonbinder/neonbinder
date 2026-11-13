---
name: reread-proof-needs-a-changed-read
description: A spec that re-reads a scan after a hand edit, using fixtures that read the same before and after, cannot fail if the re-read is dropped; ask for a fixture whose read changes (failed auto crop rescued by hand)
metadata:
  type: feedback
---

A "the edit is read again" claim proven with fixtures that already read the
right card before the edit is vacuous: drop the classify call and the spec
stays green (same band, same "Read:" line). Ask for a fixture whose read
CHANGES because of the edit. The cheapest one is usually a scan whose auto
crop FAILS: the loose tile's "Crop by hand" rescues it, and the tile going
from failed to read and paired proves the unpaired-photo stage and the
re-read in one spec.

**Why:** NEO-481 shipped recrop specs on two Score scans that read #160
either way; the spec header admitted it. The same audit found the plan's
"the demo spec covers the demo viewer" line never made it into the spec diff.

**How to apply:** for any re-read / re-match / re-classify feature, do a
mental planted break (remove the re-read) and check a spec goes red. Also
diff the plan's "Affected specs cover X" list against the actual spec diff,
line by line. Related: [[seeded-terminal-state-spec]], [[one-big-spec-many-screens-axe-gap]].
