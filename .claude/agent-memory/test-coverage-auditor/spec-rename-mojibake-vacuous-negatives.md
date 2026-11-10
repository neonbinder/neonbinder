---
name: spec-rename-mojibake-vacuous-negatives
description: A spec moved/renamed by tooling can lose its non-ASCII chars (ellipsis, arrow) to mojibake; negative asserts then pass vacuously
metadata:
  type: feedback
---

When a PR renames or rewrites a spec, grep the changed files for the mojibake lead byte (`grep -c $'\xc3\xa2'`) and compare with the old file.

**Why:** NEO-475 moved two seller specs and an ellipsis/arrow became `â¦` / `â`. A `toHaveCount(0)` on the corrupted text can never fail (a regression is hidden), and a link-name locator can never match. Counts of `expect(` and `expectAccessible` were identical old vs new, so a count comparison alone misses it.

**How to apply:** for any `git diff -M` of a moved spec, run the byte grep on every changed file and list each hit as a weakened assertion (blocker when negative).
