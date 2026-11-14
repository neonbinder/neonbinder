---
name: patterns-first-seller-press-may-wait-for-the-seller-account
description: A seller spec's first BSC press can be held while NB waits for BSC to name the seller account; how the walk and the a11y check handle both orders
metadata:
  type: reference
---

A listing-on BSC seed is one store; the seller account may land minutes later (NEO-483). The first press then queues the cards, Sync status shows "Waiting on BuySportsCards…" with NO ledger and NO result line, and the run starts by itself.

- Never gate a first press on `run.underWay(resultLine)`: neither exists while the press is held. Use `expectRunOrSellerWait` (support/collection.ts): settles on run | settled | wait line | "Seller account in use", runs `expectAccessible` on the wait line, records a `seller-wait` annotation.
- `followRunToRest` with `marketplace` makes the CLAIM wait `expectAfterMarketplace` capped at `SELLER_ACCOUNT_CAP_MS`; the cap is a signed-off-by-Jason ceiling (GUIDE rule 3) and void if the background read's delays change.
- An optional wait line is an app-state branch: settle with one `.or()` wait first, branch for free, and keep every assert after the walk unconditional (R2). The branch only adds a check; it never replaces the feature's end state.
- "Seller account in use" is the platform badge (`platform.getByText(word, { exact: true })`); the longer note sentence does not match exactly. Throw by name, never wait it out.
- Seller specs cannot run locally (one shared account), so the planted-break check has to wait for a shared-dev/preview run.
