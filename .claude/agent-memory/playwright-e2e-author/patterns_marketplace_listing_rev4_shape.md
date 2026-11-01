---
name: patterns-marketplace-listing-rev4-shape
description: NEO-370 Rev 4 listing spec shape - Start on Profile, Sync button + Sync status row, stop listing only by removing the sign-in, throttle quirk on the first Sync toast
metadata:
  type: reference
---

How the Rev 4 BSC listing spec is built (supersedes the leave-the-checklist shape in [[patterns-marketplace-listing-spec-shape]]):

- Listing starts only with Profile's "Start listing on BuySportsCards" (region "Listing on BuySportsCards"); saving a sign-in starts nothing. The only way to STOP is Clear Credentials, which also clears the start and drops the queue. So the afterEach ALWAYS (pass too) removes the sign-in then re-saves it with the seed hop (`support/credentials.ts` `removeBscSignIn` / `saveBscSignIn`), and asserts Start is offered again.
- Result surface is Inventory -> Sync status (`?tab=sync`): region "BuySportsCards", list "Last sync by set", row named by the set (a Base checklist reads as the set alone, "1988 Topps", not "1988 Topps Base"); counts line "N listed, M updated, K taken to 0" (zeros omitted; `pushed` includes the zeroed).
- Sync on the checklist is `Sync <checklist title>`; the first press right after box writes hits the server throttle (change queued < 60 s) - it still kicks the run but the toast reads "just synced". Assert the RESULT, not that toast, on a first press.
- Failure cleanup order: wait "Nothing syncing right now." (a run under way plans from old counts), empty the box, Sync, wait the set row "0 listed", only then remove the sign-in. Never delete a box that still holds copies (they fall into the listed Unsorted box).
- A dormant state row keeps its seller account, so another NB account's Start reads "seller account in use" until a reset: one worker may run the spec per pass.
