---
name: read-only-reuse-of-owner-component
description: When a visitor view reuses an owner component, check extracted-hook owner wiring, the order of privacy switches in the spec, and data-shape branches the spec fixture never reaches
metadata:
  type: feedback
---

When a PR reuses an owner screen read-only for visitors, a long visitor spec reads as thorough but tends to miss four things. Ask for each.

1. **Hook moved out of the owner page.** The visitor spec proves the hook, not the owner's call to it (its active flag, its root ref, its clamp). Grep the owner's tests for the key or event; if nothing presses it there, a planted break in the owner wiring stays green.
2. **Privacy switch checked while the page is already closed.** A spec that makes the page private first, then flips a shelf or flag switch, can only see not-found. It never sees the page drop the flag. Check the order of switches against what each one is supposed to change on a page that stays open.
3. **Branch keyed on data shape.** A helper that draws a different layout for a stored setting (sorted vs placed) gets its own copy of per-item mapping. A unit test on the default layout does not cover the other copy. Compare each mapping step across both branches.
4. **"Fixture is too hard" as the reason for unit-only.** Check whether another spec already builds that fixture through the UI (an inline file upload, a settings checkbox). If it does, the reason does not hold.

**Why:** seen on a public binder reuse where a 300-line spec had no live proof of the photo flip, the shared-slot layout or the private-flag drop, and the owner's key wiring had no test at all.

**How to apply:** map each known limit the caller lists to the exact unit test and try a mental planted break; keep the limit only if a test goes red. See also [[one-big-spec-many-screens-axe-gap]].
