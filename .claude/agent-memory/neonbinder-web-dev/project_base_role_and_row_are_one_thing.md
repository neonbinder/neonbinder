---
name: base-role-and-row-are-one-thing
description: A variant type's TITLE is its kind (Base / Insert(s) / Parallel(s), exact word) since NEO-334 (Jason, 2026-10-10) — no isBase/variantRole flag, no "Mark as base set"; a kind-changing rename is refused while rows sit beneath the type
metadata:
  type: project
---

NEO-334 replaced the NB role flags (`metadata.isBase` from NEO-239,
`metadata.variantRole` from NEO-306) with the title: `variantTypeKind(row)` in
`convex/variantRole.ts` reads the trimmed, whitespace-collapsed, case-folded
title and matches it WHOLE against base | insert(s) | parallel(s). "Insert
Set", "Base Parallels" have no kind. FE and server both call that one rule; a
hand-typed "+ Custom" variant type called "Insert" IS an Insert type (the old
"hand-typed types have no role" gap is gone).

Rules that come with it (Jason, 2026-10-10): exactly one Base per set; a type
becomes the Base by being renamed "Base" (`setBaseVariantType` and the
"Mark as base set" control are deleted); singular and plural are the same word
for every sibling title ("Promo" + "Promos" refused); a rename that changes a
type's kind is refused (`VARIANT_TYPE_RENAME_REFUSED`) while inserts,
sub-variants or cards sit beneath it; `features.cardType` is not re-derived on
rename.

**Why:** the hobby's own words are NB vocabulary, and sync never renames an NB
row after creation, so a marketplace's naming only matters at creation (the
direction invariant 2 allows). A flag beside the title was a second answer
that could disagree. The NEO-306 lesson still holds: a type's structural kind
never changes while rows hang off it — then it was "never clear isBase", now
it is the rename refusal.

**How to apply:** never reintroduce a role flag, a substring match, or a
"mark as" control for these three kinds. Any new kind-dependent behaviour reads
`variantTypeKind`. Invariant 4 still forbids deriving any OTHER behaviour from
a display name. Legacy flag fields are stripped by an armed migration and
removed from schema in a follow-up PR.
