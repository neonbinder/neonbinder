---
name: neo334-title-kind-and-insert-base-pair
description: NEO-334 title-is-kind rule vs the suite's hand-made "Insert › Base" pair — the insert named Base is NOT the set's Base; what a kind word typed at variant-type level now does
metadata:
  type: reference
---

NEO-334 reads a kind off a title ONLY at `variantType` level (`variantTypeKind`
in convex/variantRole.ts): exact word base(s) / insert(s) / parallel(s).

- The suite's default hand-made pair (`util-add-custom-card` INSERT_NAME
  default "Base", `util-drill-to-custom` VARIANT_TYPE "Insert" + VARIANT
  "Base", and inline in set-fill-teams / set-team-carries-down) is a TYPE
  "Insert" with an INSERT "Base". The insert is not the Base; the set has no
  Base, so teamFill's `baseSet` tier is skipped. Easy to misread as "a
  hand-made Base" — check the level before "fixing" it.
- Keep the type titled "Insert": it is Insert-kind, so picking "Base" opens the
  Sub-Variants (7th) column — the layout these flows were measured with.
  Retitling it to a non-kind word removes that column and changes the
  horizontal-scroll measurements (set-team-carries-down's re-drill comment).
- Typing a kind word as a VARIANT TYPE now has effects: "Base" is terminal
  (no Variants column; util-drill-to-custom cannot drill it), a second Base and
  a same-word sibling ("Insert" beside "Inserts", "Promo" beside "Promos") are
  refused at create. Same-word is variant-type level only; inserts keep the
  exact-name rule.
- Sweep recipe: grep `inputText` after `Add custom Variant Types` plus every
  `VARIANT_TYPE:` env, grouped by SET_NAME prefix, to find sibling pairs.

Related: [[variant-type-title-is-its-kind]] flow owns the rule's E2E proof.
