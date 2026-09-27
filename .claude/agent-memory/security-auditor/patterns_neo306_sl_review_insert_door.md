---
name: patterns-neo306-sl-review-insert-door
description: NEO-306 SportLots-only review (slSetReviews) + Make insert of… door — the server-held doc is the allowlist and the mutex for client-sent SL ids; a hard assert on a marketplace-controlled field inside a per-scope write aborts the whole sync; role flags conferred adds-only have no correction path
metadata:
  type: project
---

Durable review rules from the NEO-306 audit (2026-09-25):

- **A server-held staging doc is the right allowlist for client-sent
  marketplace ids.** `applySlSetReview` takes `{slId, variantTypeId?}`; the
  label comes from the doc, an id the doc does not hold is skipped and
  counted, and each chunk removes its entries IN THE SAME TRANSACTION that
  files them — so the doc is also the mutex between two admins' saves. Check
  any future "review then save" surface for all three properties.
- **Assert vs drop on marketplace-controlled fields.** `replaceScope` throws on
  an SL id > 64 chars, but `routeSlSets` (the routing tier) never drops such
  ids, so one odd upstream id fails the WHOLE Sync Sets (every scope, one
  try/catch). The tier that sees upstream data must drop-and-count; the
  boundary assert is only a backstop. Same shape as
  [[patterns-name-bounds-three-tiers]].
- **Brand-wide covered check read once in an action, per-type check in each
  chunk transaction** leaves a seconds-wide TOCTOU against other doors
  (promote, make-insert, reconcile) that can put one SL id on two rows.
  Admin-only, concurrent-operator only — a note, not a blocker.
- **Adds-only conferred flags (`metadata.variantRole`, `isBase`) are sticky.**
  Conferred from BSC ids that an admin client can supply
  (`storeReconciledOptions` takes raw ids), never flipped, and no operator
  editor exists — a wrong role is a DB edit. Integrity note on every new
  adds-only flag.
- Registry: NEO-306 added all 10 new public fns to publicFunctionAuth.test.ts
  (both refusal identities + a write-nothing assertion + an admin pass) and
  pinned the internal helpers by source-grep — the model shape to ask for.

Related: [[patterns-neo305-set-parallel-conversion]], [[public-function-auth-registry]].
