---
name: patterns-marketplace-listing-rev4-shape
description: NEO-370 Rev 4/5 listing spec shape - a saved sign-in syncs (seed hop listing=on starts, plain seed is Not syncing), Sync button + Sync status row, stop by removing the sign-in and re-seeding without listing=on
metadata:
  type: reference
---

How the Rev 4 BSC listing spec is built (supersedes the leave-the-checklist shape in [[patterns-marketplace-listing-spec-shape]]):

- Rev 5: "if you have credentials you are syncing"; no Start button. `/testing/seed-credentials` marks a seeded BSC sign-in "not syncing" (Profile panel reads "Not syncing.", Sync inert, Sync status pill "Not syncing") unless `listing=on`. Start syncing = the seed hop with `listing=on` (`saveBscSignIn(page, {listing:true})`); stop = `removeBscSignIn` then `saveBscSignIn(page)` without it. The consent warning ("Heads up: connecting starts listing") sits on the sign-in form and describes Connect, so it is only visible with the sign-in removed. A real Profile-form save would start real listing: no spec may do one.
- Before syncing starts (saving walks every listed box), put every other box, Unsorted included, in-person via My Boxes.
- Result surface is Inventory -> Sync status (`?tab=sync`): region "BuySportsCards", list "Last sync by set", row named by the set (a Base checklist reads as the set alone, "1988 Topps", not "1988 Topps Base"); counts line "N listed, M updated, K taken to 0" (zeros omitted; `pushed` includes the zeroed).
- Sync on the checklist is `Sync <checklist title>`; the first press right after box writes hits the server throttle (change queued < 60 s) - it still kicks the run but the toast reads "just synced". Assert the RESULT, not that toast, on a first press.
- Failure cleanup order: wait "Nothing syncing right now." (a run under way plans from old counts), empty the box, Sync, wait the set row "0 listed", only then remove the sign-in. Never delete a box that still holds copies (they fall into the listed Unsorted box).
- A dormant state row keeps its seller account, so another NB account's Start reads "seller account in use" until a reset: one worker may run the spec per pass.
