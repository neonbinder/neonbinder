---
name: inverted-skip-path-loses-its-live-proof
description: when a feature makes a dialog open where it used to be skipped, the specs that proved the skip are rewritten to the new rule and the old path survives only as an .or() branch
metadata:
  type: feedback
---

When a PR flips a rule ("one marketplace skips Match Cards" becomes "marketplace plus a stored source opens it"), the specs that asserted the skip get renamed and rewritten to the new rule. The unchanged case (no extra source, still skips) is then proved only where some old spec kept an `.or()` branch with an `if (await dialog.isVisible())` guard.

**Why:** a large checklist PR rewrote five specs this way; the plain one-marketplace, no-checklist skip kept one soft proof.

**How to apply:** grep the removed `-` lines for the old sentence, then grep the tree for a hard assertion of it. If only an `.or()` remains, ask for one spec that asserts the unchanged path hard. Same for a removed state whose replacement behaviour has no live proof. See [[a-green-suite-can-mean-the-test-stopped-testing]].
