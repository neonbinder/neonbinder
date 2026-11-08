---
name: patterns-finally-cleanup-without-an-isvisible-branch
description: How a spec's finally/afterEach closes a run or tidies rows deterministically — a flag set right after the closing click, no `.or()` + isVisible branch, every tidy step bounded, none skipping the rest, body failure never masked
metadata:
  type: pattern
---

A cleanup that must close something only when the body did not ("Done adding
photos" on a run) is a state question, not a visibility one. Do not write
`await expect(done.or(closed)).toBeVisible(); if (await done.isVisible()) ...`:
it is an instant branch (the reviewer rejects it) and the pair of states it
tests is knowable from the spec's own flow.

- Set a flag the line AFTER the closing click resolves (`doneClicked = true`),
  or clear the "run is open" record there (`written.runUrl = undefined`) BEFORE
  the closed-note assertion. The cleanup then presses Done only when the flag
  says the run is still open, with one plain `click()` (7 s, auto-waits for the
  button) and one assertion on the closed note.
- Run each tidy step (close run, clear common price, delete box) through a
  `tidy(step)` that catches into a list, so one stalled step never skips the
  rest. After them: throw the first leftover only when the body passed; when the
  body failed, put it on `test.info().annotations` so the body's own error stays
  the one the report shows (a throw in `finally` replaces it).
- A closed run's id stays on the URL, so `/[?&]run=/.test(page.url())` means
  "a run exists", never "a run is open"; pair it with the flag.
- Proving a conditional panel state ("Min price is blank again") can use the
  button that mirrors it (`Defaults: Near Mint` vs `Defaults: Near Mint, $0.25`
  by accessible name) instead of opening the panel with an `aria-expanded`
  branch.

A horizontal overflow inside a lane (a status pill clipped in a ~125 px lane at
the desktop project's 1024 px width) shows up as axe `scrollable-region-focusable`
on `section[aria-label="Cropping & reading, N"] > .overflow-auto`. Seen on the
desktop project only; the same spec passed on the phone project.

Related: [[patterns_marketplace_listing_spec_shape]]
