---
name: patterns_failure_hook_that_finishes_every_step
description: afterEach shape for specs that leave seeds, a copy and a box behind on a red - fresh page from the context, attempt() collects errors, state in a module-level object, idempotent steps
metadata:
  type: feedback
---

A spec that writes through the UI (a box, a copy) or through a `/testing/seed-*` hop must tidy on a
failure too, or the next spec on that worker meets its leftovers ("None yet" no longer true, a sync
problem it never made on the dashboard).

Shape (NEO-464 `real-sync-status-and-sale`, `real-sell-and-take-off-sale`, `real-shelf-box-overflow`):
- module-level `written = { box?, card? }` set by the body right BEFORE each write (so a death mid-write is covered);
- `test.afterEach(async ({ context }, testInfo) => { if (testInfo.status === testInfo.expectedStatus) return; const clean = await context.newPage(); ... finally { await clean.close() } })` (the context is already signed in);
- each step wrapped in `attempt(step)` that pushes to `failures`, the first rethrown at the end, so one red step does not skip the rest;
- steps are idempotent: the card panel settles on `none.or(remove)`, then branch on `remove.isVisible()`; a box already gone is skipped (`support/collection.ts` `deleteBoxNamed`);
- a body that passes does its own final tidy and clears `written`; planting a `throw` after the first write proves the hook (the next run's fresh "None yet" proves it cleaned).

**Why:** GUIDE gotcha "A failure hook finishes its tidy-up".
**How to apply:** reuse `deleteBoxNamed(page, name)`; seven-box specs loop it over the names the body pushed to a `made` array.
