---
name: reference-new-string-maestro-collision-sweep
description: How to prove a new user-facing (incl. sr-only) string cannot satisfy an existing Maestro text:/id: selector — compile every selector as a full-anchored regex and test it, then check which page each hit runs on
metadata:
  type: reference
---

Before shipping a new string (live-region copy, labels, sr-only text), sweep every flow selector rather than eyeballing:

1. `grep -rn -o -E '(text|visible|notVisible|assertVisible|assertNotVisible|id): *"[^"]*"' .maestro/flows > patterns.txt`
2. A small node script compiles each value as `new RegExp("^(?:" + v + ")$", "s")` (Maestro matches full-string) and tests the candidate strings.
3. For each hit, find the nearest preceding `openLink`/`url:` to see which page the step runs on — a hit on a page that never renders the component is not a collision.

**Why:** loose regexes like `".*matches.*"` exist (Players admin counter); NEO-224's per-column "N matches" sr-only region would have matched them had they run on the set builder. They don't (all after `openLink …/admin/players`), but only the page check proves it.

**How to apply:** run it whenever adding copy to a screen flows touch; re-run at the end of a round if a maestro author is editing YAML concurrently. Related: [[reference-maestro-web-text-is-direct-text-nodes-only]], [[dom-id-shadows-aria-label-in-maestro]].
