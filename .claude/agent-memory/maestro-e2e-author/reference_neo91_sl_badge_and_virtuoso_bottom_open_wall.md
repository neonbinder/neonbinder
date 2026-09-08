---
name: neo91-sl-badge-and-virtuoso-bottom-open-reachability-wall
description: NEO-91 SL per-card badge verification (fetchSportLotsChecklist setRadioId fix) + the hard rule that CardChecklist virtuoso opens at the BOTTOM and Maestro cannot drive its inner scroll up, so TOP-of-list cards are unreachable
metadata:
  type: reference
---
## NEO-91 fix (verified live on shared dev, 2026-07-17)
`fetchSportLotsChecklist` (convex/adapters/sportlots.ts) used to read `setRadioId`
from `platformFilters.setName` (SL never populates it) → SL per-card checklist
matched ZERO for every set → NO card ever had `cardChecklist.platformData.sportlots`
→ the "SL" row badge (CardChecklistItem line ~163, a truthiness check on that field)
NEVER appeared, app-wide. Fix resolves `setRadioId` from `parallel||insert||variantType||setName`.
Also: `platformData.sportlots` now stores SL's full description text, not the bare card number.
Plus a new backend-only `cardChecklist.sku` field (`NB-...`), no UI surface.

VERIFICATION (live, definitive): dumped `npx convex data cardChecklist --limit 30000
--format jsonl` — BEFORE a fresh sync: 0/2249 rows had platformData.sportlots. AFTER
re-fetching 2024 Topps Chrome Base ("Refresh from Marketplaces" under the deployed fix):
**88 Base cards (#1-88 exactly, contiguous) got platformData.sportlots** (=SL's first Base
page for radio 309098). Chrome visual confirmed #1 Ohtani, #2 Colt Keith, #3 Burnes,
#4 Freeman … #10 Buxton all render BOTH "SL" and "BSC" badges. Fix WORKS.
(2024 Topps Chrome / Base is the ONLY variant in that subtree with an SL id = 309098;
inserts/parallels have none, so only Base gets SL cards.)

## THE WALL: CardChecklist virtuoso opens at the BOTTOM → top cards UNREACHABLE
`components/SetSelector/CardChecklist.tsx` sets `initialTopMostItemIndex = sortedCards.length-1`
(deliberate: E2E flows look for just-SAVED cards at the bottom — team-picker Test 7,
features-propagation Step E). So after ANY drill, virtuoso rests at the LAST card
(#300 for the 335-card Base), NOT the top. Proven empirically:
- Maestro's page-level `scrollUntilVisible direction: UP` (for "SL" or `id:"Edit card N"`)
  does NOT drive the inner virtuoso — it bubbles to the PAGE and walks up to the Admin-Tools
  header, leaving the whole list off-screen below. Tested with the list pre-centered
  (`scrollUntilVisible id:"Edit card 300" centerElement` first) + a 120s UP scroll to
  `Edit card 40`: FAILED "not found." The page always has ~600px of scrollable content
  above the checklist (selector columns / admin tools / multi-source panel / attributes),
  so UP swipes reveal that before ever reaching the inner list.
- DOWN scroll only ever confirms the already-visible bottom rows (#290-300).
- The only programmatic virtuoso scroll is `selectByIndex → scrollToIndex(center)`, driven
  one-card-at-a-time by the CardDetailPanel prev/next arrows — no jump/Home/End — so reaching
  a top card = ~240 single steps. Not viable.
NET: **a card at the TOP of a large bottom-opening checklist is not reachable by Maestro.**
Since NEO-91's SL matches land on #1-88 (top) of the 335-card Base, a row-level "SL" badge
assertion is NOT feasible as a green Maestro flow. Left to unit tests + live verification;
documented the finding in `checklist-renders-rich-fields.yaml`'s NOTE (that flow asserts BSC
generically — BSC is everywhere including the bottom — and does NOT assert SL). The
CardDetailPanel drawer does NOT surface an SL/BSC platform badge either (only the
"unmatched-bsc"→"SL only" reconciliation tokens), so the drawer is not an alternate surface.
If SL-badge E2E is ever wanted, it needs a product affordance reachable at the bottom
(e.g. a source filter, an open-at-top toggle, or an SL indicator in the drawer).

## Chrome-JS trick to observe/scroll a react-virtuoso list (Maestro can't, JS can)
Find the scroller: `[...document.querySelectorAll('div')].find(d=>{const s=getComputedStyle(d);
return (s.overflowY==='auto'||s.overflowY==='scroll')&&d.scrollHeight>d.clientHeight+50})`.
To force it to the top AND make virtuoso re-render the window: `sc.scrollTop=200;
sc.dispatchEvent(new Event('scroll')); await 300ms; sc.scrollTop=0;
sc.dispatchEvent(new Event('scroll')); await 1500ms`. A plain `scrollTop=0` sets the offset
but virtuoso keeps rendering the old (bottom) window until a scroll event nudges it; also the
list must be IN the viewport or virtuoso unmounts all rows. Testing sign-in works in a normal
Chrome tab: `/testing/sign-in?redirect=/set-selector&worker=0`.
