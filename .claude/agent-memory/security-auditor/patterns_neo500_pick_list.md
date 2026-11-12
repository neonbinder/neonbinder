---
name: patterns-neo500-pick-list
description: NEO-500 Pick List — gate-skip options on shared *Core functions are a grep target; hashed line ids over marketplace keys are opaque not secret; sold-copy photos stay bearer-live; testing seeds go unregistered
metadata:
  type: project
---

What held, and what to re-check when this area changes:

- **`*Core(ctx, args, { skipPollGate })` split.** The internal wrappers
  (`recordOrder`, `applySaleItems`) pass no options; only `testing.ts` passes
  `skipPollGate`. Grep `skipPollGate` on every diff that touches listingSales:
  it must appear only in listingSales.ts and testing.ts. Owner, sale status
  and per-line `applied` are still checked inside the core.
- **Line ids `${saleId}~hash53(platformCardId|condition|sku#n)`.** They are
  opaque, not secret. A non-crypto 53-bit hash over a key the seller mostly
  knows can be brute-forced back to the marketplace card id. Acceptable for
  the seller's own data. If a line id ever crosses owners, use HMAC or a
  stored random id instead.
- **SKU-derived box hints** (`parseListingSku(item.sellerSku)` → box id) are
  marketplace-controlled strings. They are safe only because `ownHome`
  re-checks `ownerId`. Keep that check.
- **Sold copies keep their photos** (the copy row is deleted, the photo rows
  stay `live`), so the `/copy-photo/<token>` bearer URLs stay valid
  indefinitely. `ownerPhotoUrlsByCopyId` checks ownership on the photo row,
  which is correct. Retention and cleanup are still open.
- **Testing seeds (`testing.seedMyTest*`) are public mutations, and the
  hand-maintained auth registry does not list them.** Their gate tests live
  in `testing.*.test.ts`. Flag a missing registry entry anyway, and check
  that those test files are committed rather than left untracked.

Related: [[patterns-testing-endpoint-gate]], [[public-function-auth-registry]].

NEO-509 added `items[].listed` (the platform's card description) to sales:

- **Two re-checks held:** the parser reads only named `card.*` keys and the
  item `sportId` through `bscListedText` (trim, bound, reject C0/C1), and
  `recordOrderCore.storedListed` re-applies the same rule, so the testing
  seed and any future caller get the parser's bounds. The platform sport id
  is resolved to NB's sport row (exactly-one over `slotIds`) and never
  stored or returned.
- **Every other public reader of `marketplaceSales` projects explicitly**
  (`listingSync.publicSale`), so a new stored line field does not leak there.
  Grep `query("marketplaceSales")` for public readers on each new field.
- **Gaps left as notes:** `CONTROL_CHARS` does not reject bidi or
  zero-width format characters (U+200B-U+200F, U+202A-U+202E, U+2066-U+2069).
  The client also files an unmatched line behind an NB set by folded-name
  equality with an exactly-one guard. That is display-only, but it is a
  name-keyed behaviour under invariant 4.
