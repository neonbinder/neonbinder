---
name: patterns-neo532-discovery-hint-stamp
description: A row-level "last activity" stamp read through a new index to feed a global signed-in list — who can write it, what the list returns, whole-row validator reach, and the page-level arm pin
metadata:
  type: project
---

NEO-532 added `selectorOptions.lastCardAt` (stamped by `CardCountLedger.flush`)
plus `by_last_card_at`, read by the signed-in `dashboard.newSets` to find
recent checklist uploads. Audit checklist that held, reusable for any
"stamp as discovery hint" design:

- **Who can move the stamp.** Grep every `createCardCountLedger` caller and
  every helper that takes a ledger (`insertCardRow`, `removeCardRow`,
  `moveCards`, `rehomeSetRowsToBrand`). All were `requireAdmin` or
  `internalMutation`; if a collector door ever reaches the ledger, a user
  can push rows into every collector's list (it is a global index).
- **What the list returns.** The stamp must stay a hint: the returned time
  must be the real card `_creationTime`, never the stamp, or a stale stamp
  (delete never moves it back) becomes displayed data.
- **Whole-row validators.** `selectorOptionDocValidator` spreads
  `selectorOptionFields`, so a new field rides into every whole-row return.
  Its consumers were all admin-gated; re-check the gate list, and grep
  `...selectorOptionFields` in ARGS (a client could forge the field).
- **Armed backfill pin.** The action-level refusal is usually tested; the
  page `internalMutation` (`apply: true` while unarmed must throw) usually is
  not, though `npx convex run` reaches it directly. Ask for that test.
- A full top-N page of stale stamps hides older-stamped rows with newer real
  cards (rows past the page are never read): correctness, admin-only lever.

Related: [[patterns-neo464-dashboard-aggregator]], [[patterns-neo358-collector-rows-pin-catalog]].
