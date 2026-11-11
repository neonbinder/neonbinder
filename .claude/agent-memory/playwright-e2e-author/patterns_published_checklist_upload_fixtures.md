---
name: patterns-published-checklist-upload-fixtures
description: NEO-478/482 specs upload a captured CSV instead of letting a fetch ask BSC per card; which sets cannot (all NNO), N of M arithmetic, measured-wait helper
metadata:
  type: reference
---

- A fixture CSV is a capture of BSC's own answers (public storefront search + per-card card-listing, laptop, 1 call/s, backoff on 429). Rule 7 matching pairs a number only when it is exactly one on BOTH sides, so a set whose cards are all `NNO` (Roanoke, Louisiana, Silk Collection) cannot use an upload: keep its live fetch. Check the numbers of any candidate set (shop search, one call) before capturing.
- `Teams from your checklist: N of M cards`: N = rows whose number is on exactly one row (`checklistFacts().matched`), not rows with a team; M = cards.
- `expectAfterMarketplace` (support/marketplace-wait.ts): own time = elapsed - time the "Waiting on <platform>" status was on screen, plus a 1.5 s back-credit per episode (the product mounts the line after ANNOUNCE_AFTER_MS). Prove the credit through the `marketplace-wait` annotation, not pass/fail: at the 7 s threshold it rarely flips a result.
- A blocked Next shows its status only after a blocked press, and Next may be aria-disabled (click() waits): use the Enter shortcut the footer names.
- Disagreement choices are radios in a radiogroup `Disagreement on #N` (number regex needs a not-followed-by-alphanumeric guard: #6 vs #60).
- A background `node` capture started with `&` can be STOPPED by the shell (TN state); start it with stdin from /dev/null and output redirected, and cd to the dir the script path is relative to.
