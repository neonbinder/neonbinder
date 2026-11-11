---
name: reference-failure-png-is-viewport-only
description: A Playwright failure PNG is the 1024x629 viewport, so anything under a Set Builder column card is cut off; "not in the screenshot" proves nothing, read the error-context in the blob zip
metadata:
  type: reference
---

`screenshot: "only-on-failure"` captures the viewport, not the page. At the CI size (1024x629) a populated-looking Set Builder column can fill the frame, and everything `EntityColumn` draws under its card (the sync error, Sync, "+ Custom") starts below the fold. Absence from the PNG is not evidence of absence.

**How to apply:** before concluding a control or message did not render, read the failure's ARIA snapshot. `results.json` lists it as the `error-context` attachment; a downloaded report keeps it as `resources/<hash>.md` inside `report/blob/report-*.zip`, and a results folder may hold only the PNG. Sanity-check the geometry with the neighbouring column: if its buttons sit 16px under its card, this column's would too.

**Related trap:** a grep for a literal string misses a locator that builds it at runtime. `selectOrCreate` reads `` `No ${column.toLowerCase()} available` ``, so grep the fragment as well as the sentence. A `toBeHidden()` on a line the product stops drawing also passes for a new reason, so check each hit for a check it silently loses. See [[reference_new_string_locator_collision_sweep]].
