---
name: patterns-neo296-transaction-bounds
description: Auditing a transaction-bounding change (pages, budgets, self-scheduling chains) — the four questions that find the regressions a bounding ticket introduces
metadata:
  type: feedback
---

When a diff bounds previously-unbounded Convex work — a page plus
`{hasMore, cursor}`, or a `scheduler.runAfter(0, <itself>)` chain — the new
risk is almost never the bound itself. Ask these four:

**1. Does every client caller of a newly-bounded PUBLIC mutation read
`hasMore`?** A write budget added server-side, with callers left untouched,
converts an over-budget call from a Convex error into a **silent partial
write reported as success**. Grep every `useMutation(api.<mod>.<fn>)` call
site in the same PR, not just the one the ticket was about; the server may
return an honest `message`, but a caller that prints its own
`` `Stored ${items.length}` `` overrides it.

**2. Was a SHARED total budget replaced by a PER-ITEM one?** A cache carrying
`spent` across a whole transaction bounds the transaction. Swapping it for a
`consulted` set created per call re-arms the budget per item, so the real
ceiling becomes `perItem × items` — which can be larger than what the
unbounded version cost. The deleted doc comment usually says exactly this
("re-arming per name — which was no bound at all"); read what the diff
removes, not just what it adds.

**3. Does the continuation re-establish the scope its scheduler call had?**
The house shapes that work:
- a token the cancelling transaction wrote (`finishedAt` compared against a
  `canceledAt` arg) — forgery-proof because the function is `internalMutation`
  and only an authorised caller can schedule it;
- an identity re-check against live state (`brand.metadata.setNamePrefix !==
  args.prefix`, `existing?.batchId !== args.continueBatchId`);
- an `.eq()` on the same scope the first page asserted ownership over, so a
  client-supplied cursor can only make the walk examine FEWER rows.
A continuation that carries a `userId` arg is fine only if the scheduling
public function derived it from `requireAdmin`/`getCurrentUserId` rather than
from its own args.

**4. Does the cursor strictly advance?** The safe idiom is "the cursor is the
last row EXAMINED, never the last row written" — a page whose whole budget
went on refusals still moves. Check the zero-progress case: an empty page, a
budget already spent at entry, and a `clamp` whose floor is 0 rather than 1.

Also: a bounded READ that answers a uniqueness question (is this name taken
under the target?) must FAIL CLOSED on overflow. Truncate-and-proceed is only
correct when the answer is a name map or a display hint.
