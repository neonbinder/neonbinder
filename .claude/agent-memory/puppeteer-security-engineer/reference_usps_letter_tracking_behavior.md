---
name: usps-letter-tracking-behavior
description: How a USPS First-Class letter actually behaves in EasyPost tracking — terminal status, scan count, code length, misleading first message. Ground truth for tracker fixtures and UI copy.
metadata:
  type: reference
---

Ground truth from a real production NEO-120 letter (Madison WI → Olympia WA,
Aug 2026), used as the fixture for every tracker test in `services/browser`.
Verify against a live tracker before assuming any of it still holds.

- **`out_for_delivery` is the NORMAL terminal status for a letter, not an edge
  case.** `delivered` never arrives — no USPS scan confirms a mailbox. Treat
  `out_for_delivery` as the done state in any status→words mapping.
- **~4 scans over 3 days**, all sorting-machine events. There is no acceptance
  scan.
- **The tracking code is a 31-digit IMb**, not the 22-digit code parcel
  integrations assume. Never validate tracker codes by length.
- **The first USPS message reads "Origin Processing Cancellation of Postage".**
  It means the stamp was postmarked. To a seller it reads like a refund or a
  void, so seller-facing UI needs a gloss.
- **`tracking_location` fields come back null**, including on the final
  "Delivery" scan. Normalising them into the string `"null"` is how a row ends
  up rendering "Delivery · null, null".
- EasyPost hands back a free public tracking page on every tracker
  (`public_url`, a `track.easypost.com/...` link) — that is the shareable page,
  no aggregator needed.

What this does NOT establish: that webhook delivery works. It only proves
letters generate tracker updates. Webhook delivery has to be proven separately
against a real deployment.
