---
name: patterns-checklist-commit-trust-boundary
description: commitCardChecklist (selectorOptions.ts) trust boundary — where marketplace-controlled strings can steer writes, and the four invariants that keep them from doing so
metadata:
  type: project
---

`commitCardChecklist` is an `action` (`requireAdmin` at the top) that fans out to
three `internalMutation` phases: prelude → chunk(s) → finalize. Its `cards` arg
is **client-supplied** (`previewCardValidator`) and carries raw marketplace
strings: `platformData.{bsc,sportlots}.{ref,setId}`. The SportLots `ref` IS the
listing description (NEO-91), so it is unbounded upstream-controlled text.

Four invariants hold today and must survive any change to the matching or write
semantics:

1. **setId is never used raw.** `resolveCardSlots` (selectorOptions.ts ~L115)
   resolves `wire.setId` through the PARENT row's slot map
   (`slotEntries(row, side)`) and yields `src: undefined` when the set is not
   attached. It used to allocate a slot for any id a card named — that was fixed;
   the comment at ~L146-162 explains why (an injected slug widens the next
   privileged BSC fetch, which filters on `slotIds(ancestor, "bsc")`). Any new
   matching tier keyed on setId must go through the same resolution. Comparing
   an incoming `setId` against a stored `src` directly is a slot-key injection
   (`src` values are `b0`/`s0`/…, trivially guessable strings).
2. **Row identity is scoped by snapshot, not by `db.get`.** The prelude reads
   `cardChecklist` by `by_selector_option`; the chunk rebuilds `rowsById` from
   the same index and does `rowsById.get(card.existingId)`, so a foreign id
   falls through to insert rather than writing cross-set. Never replace that
   with `ctx.db.get(existingId)`.
3. **Patched fields are a literal list**, never a spread of the incoming card.
   `selectorOptionId`, `sku`, `isCustom`, `features`, `variationParentManual`,
   `variationOfCardId` are outside it.
4. **Additive-only background writes re-check at write time.**
   `cardChecklist.applyBscTeamResolution` (~L250) returns early when
   `teamOnCardIds` is already non-empty — the check is inside the mutation, not
   at enqueue time. That is the pattern any "apply only if unchanged" gate
   should copy.

**Deletion cascade is inconsistent.** `deleteCard` does
`deleteCardCrossListingsFor` + `orphanVariationsOf`; the finalize stale sweep
does only the first, so it leaves dangling `variationOfCardId`. Any new bulk
delete path must do both. (Same shape as the NEO-21 finding.)

**Logging convention for marketplace strings:** bounded sample + full count —
`refs.slice(0, 5).join(" | ")` (fetchCardChecklist ~L5109/5123) or
`.slice(0, 20)` plus a count inside `JSON.stringify({...})` (commit ~L6760).
Prefer the JSON.stringify form: the string-concat warns are unescaped, so a
newline in an SL description forges a log line.

**Release-safety note that is also a security default:** Convex is a hard
mid-deploy cutover (an old SPA talks to the new backend for minutes). New commit
args must be `v.optional(...)` AND default to the deny value (`applyContent`
absent ⇒ do not write content; `operatorDeleteIds` absent ⇒ delete nothing).
