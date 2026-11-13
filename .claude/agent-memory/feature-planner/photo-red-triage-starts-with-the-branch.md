---
name: photo-red-triage-starts-with-the-branch
description: In a multi-day photo-spec red sweep most occurrences are the branch's own in-progress work (a preprocess or drawer PR breaking its own specs); bucket by branch and by "before/after the fixing merge" before grouping by symptom
metadata:
  type: feedback
---

A sweep of failed PR Pipeline runs over two or three days looks like "the photo specs fail
a lot", but on inspection most reds cluster on one or two branches that changed the path
under test (a preprocess rewrite reds every placeholder and add-cards spec at once; a
card-drawer PR reds the drawer specs). Those are fixed by that branch's own later pushes.

**Why:** NEO-529 sweep (2026-11-13): of ~40 photo-spec reds, ~20 were one preprocess
branch's own runs, ~6 were a drawer-editing branch, and the remaining causes were
already fixed on main (leftover-copy confirm, heavy cold start after the preprocess
cut) or on an open PR (an axe pre-load target-size fix). Only a handful were live.

**How to apply:**
- Pull job logs (`gh api --allow-escape-sequences .../actions/jobs/<id>/logs`, strip
  ANSI) and parse the `✘  N [project] › playwright/tests/<spec>` lines; project names
  contain digits (`e2e`, `e2e-mobile`), so a `[a-z-]+` class silently matches nothing.
- Tag each red with its run's head branch and whether it predates the merge that fixed
  its cause; only reds on unrelated branches after that merge are live.
- Pre-load axe failures (target-size on a link around an unsized `<img>`, contrast on a
  loading placeholder) recur on photo surfaces: reserve the box before the image decodes.
Related: [[photo-red-with-upstream-502s-read-the-preprocess-traceback]],
[[leftover-copy-red-is-an-unconfirmed-final-remove]].
