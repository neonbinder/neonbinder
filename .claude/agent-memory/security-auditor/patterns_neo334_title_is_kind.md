---
name: patterns-neo334-title-is-kind
description: NEO-334 variant-type kind read from the title; how to enumerate its rename/create doors, and the id-less intra-batch twin gap in the widened (sameName) name tier
metadata:
  type: project
---

NEO-334 made a variant type's TITLE its kind (base/insert/parallel, exact word,
singular = plural) and dropped the isBase/variantRole flags. Every "one Base
per set" / "one row per word" / "sub-variants only under Insert" rule is now a
guard on doors, so the audit is door enumeration.

**Why:** a kind carried by a mutable string is only as strong as the set of
writers of that string and of rows beneath it.

**How to apply (any future rule keyed on a row's title or on what sits under it):**
- Rename doors: `grep 'planValueRename('` plus direct `value:` patches. In
  NEO-334 that was renameSelectorOption, applySelectorSyncSuggestions, the
  storeReconciledOptions tier-0 title edit (backfillBrandPrefixAndUnknownName is
  internal, manufacturer only).
- Create doors: `grep 'db.insert("selectorOptions"'` (stores, custom-add,
  setFromMarketplace, setInsertConversion, setParallelConversion, slSetReview,
  brandRehome, ensureBrandUnknownRow). Level moves: applyParallelGroupings.
- `planSelectorSync`'s pass-2 incoming twin count (`incomingByKey` /
  `incomingNamed`) counts ONLY items that carry an id. Two id-less items that
  share a name (or, with `sameName: sameTitleWord`, a word) and have no existing
  namesake are BOTH inserted. Real fetches always carry ids, so this is a direct
  admin-call door, but it defeats "exactly one Base" and "one row per word".
  Probe the pure planner with tsx from a scratchpad script; no worktree edit needed.
- storeReconciledOptions refuses `identityOnly` at variantType level (it skips
  the name tier), and storeSelectorOptions has no identityOnly arg; re-check
  both if either gains one.
- Readers that need "the" Base/Insert/Parallel type must be exactly-one
  (`variantTypeOfKind`, `baseOf`, `getBaseVariantBySet`, `pickBaseVariantType`).
  A `.find` by kind is a coin flip on legacy duplicates.

Related: [[patterns-neo325-identity-only-and-twins]], [[patterns-neo291-metadata-doors]].
