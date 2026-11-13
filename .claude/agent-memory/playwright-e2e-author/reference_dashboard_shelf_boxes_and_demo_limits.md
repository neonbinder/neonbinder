---
name: reference_dashboard_shelf_boxes_and_demo_limits
description: dashboard facts for specs - the demo has ONE box so box overflow needs a real account with 7 boxes (5 ends desktop, 3 phone), sell/take-off-sale effects on Fresh Pulls vs New Listings, the Hunt tray in the demo pile
metadata:
  type: reference
---

- The public demo's fake collector has exactly one box ("Show box"), so the boxes' shelf overflow cannot be
  proved on `/demo`. A real-account spec makes 7 empty boxes: a desktop third shelf shows 5 box ends + an
  "N more boxes on My Boxes" link, a phone (<= 639.98 px, so the Pixel 7 project) 3 + the link.
  A box end is one link named `<name>, box, <n> cards for sale`.
- Fresh Pulls = copies ADDED to a binder (`addedAt`); a Sell drops it, a Take off sale never restores it. So
  after Sell the Fresh Pull is gone and a New Listing (`<title> $5.00 1 in <box>`) stands; after Take off
  sale the listing is gone and the card is NOT a Fresh Pull again (a move). The box end's count follows live.
- In the demo's "All my cards" pile (400-odd pockets, 23 pages of nine) do not page to a card: the
  `searchbox "Hunt for one of your cards"` lists owned results with `Find <short> in Main, page N, pocket M`;
  pressing Find navigates to the binder (one extra history entry, so two Backs return to the shelf).
- The demo's New Listings has 15 tiles (6 shown), the Finest eBay set 8 held-back cards, Tuesday's Fresh
  Pulls batch 34. A card that is in two runs (Yzerman #1: Tuesday batch and New Listings) exposed a stale
  panel run (NEO-464): `useCardDrawer` keeps `extras.listIds` after the panel closes and prefers it over the
  history entry's list.
