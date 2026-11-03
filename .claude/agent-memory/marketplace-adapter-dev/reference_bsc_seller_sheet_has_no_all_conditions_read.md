---
name: bsc-seller-sheet-has-no-all-conditions-read
description: BSC's seller sheet read (seller/bulk-upload/results) cannot return every condition in one call; omitting condition or sending null is a 500, and "" or "all" return one blank template per card stamped with that string, hiding real listings
metadata:
  type: reference
---

Probed read-only against a real seller (NEO-415, 2026-11-02) to see whether
one condition-less read could replace the drain's one-read-per-condition loop.
It cannot:

- `condition` omitted, or `null`: HTTP 500 (BSC's upstream `get-products`
  call fails), about 1 s.
- `""` or `"all"` (or any string): 200, exactly one row per card, every row
  stamped with the string sent, quantity 0, price "0". Real listings in a real
  condition do NOT appear (a card listed in `excellent` showed only the blank
  `"all"` row). `""` rows are also unreadable to `narrowBscSheetRow`.
- BSC's own seller bulk-upload screen never sends a condition-less read: its
  Generate button stays disabled until a condition key from
  `common/reference/product` is picked.

Other facts from the same probe:
- A per-condition read costs about the same as an `"all"` read for the same
  set (0.7 s to 4 s per read depending on the set, not just its size; the
  first read of a run can take several times longer), so a sweep costs
  about N conditions × one read.
- Blank template rows get a NEW `productId` on every read, even back to back;
  only real (listed) rows keep theirs. Never key or cache on a template's
  productId.
- Real-condition rows carry `lastSoldPrice`/`leastPriceForType`; `"all"` rows
  do not.
- Hours after the concurrent-read incident the account still held twin listed
  rows (one card, one condition, two productIds, created ~2 s apart), so
  [[bsc-seller-sheet-reads-must-be-serial]]'s damage likely persists.

**How to apply:** to shorten a drain, read fewer conditions (the targets' plus
those NB pushed before, which the drain already does) or look for a different
endpoint; do not try a condition wildcard again.
