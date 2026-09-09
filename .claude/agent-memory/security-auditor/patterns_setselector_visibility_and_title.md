---
name: setselector-visibility-and-title
description: SetSelector admin surface — the single visibility choke point (EntityColumn `!isVisible` return null) and the one column title that is backend-derived rather than a literal
metadata:
  type: project
---

# SetSelector (admin-only) — visibility gate and `title` provenance

Two facts that recur in every audit of `apps/web/components/SetSelector/`:

**1. There is exactly ONE visibility choke point.**
All seven column selectors (`SportSelector`, `YearSelector`, `ManufacturerSelector`,
`SetSelector`, `SetVariantSelector`, `VariantSelector`, `ParallelSelector`) are
rendered only as the `selector={...}` prop of `ResilientEntityColumn`, which
spreads its props into `EntityColumn`. `EntityColumn.tsx` does
`if (!isVisible) return null;` near the end of the component, so nothing inside
a closed column ever mounts. `ResilientEntityColumn`'s own give-up/Retry branch
is separately guarded with `isVisible && gaveUp`.

**Why:** any change to `EntitySelector` that *looks* like it exposes a column
early is confined to an already-mounted column — the gate is above it. Conversely,
hoisting anything above that gate is a real boundary change.

**How to apply:** when auditing a SetSelector rendering change, check whether it
touches `EntityColumn`'s `!isVisible` return or `ResilientEntityColumn`'s
`isVisible &&` guard. If neither moved, the change cannot alter what renders in a
closed column. E2E drill utils also depend on this (`when: notVisible: "<Level>"`
guards), so breaking it fails silently rather than loudly.

**2. Six of the seven `title` props are hardcoded literals; ONE is backend data.**
`"Sports"`, `"Years"`, `"Manufacturers"`, `"Sets"`, `"Variant Types"`,
`"Parallels"` are string literals in their wrapper components. `VariantSelector`
takes `title?: string` (default `"Variants"`) and its only call site passes
`variantsColumnLabel`, derived in `apps/web/components/modules/SetSelector.tsx`
from `stableVariantTypeFlagsRef.current.value` — i.e. a `selectorOptions` row's
`value`, which is marketplace-synced / admin-entered backend data.

**Why:** it means `title` is not automatically a safe constant. It is rendered as
JSX text (`<h2>{title}</h2>`) and interpolated into `aria-label` / `placeholder`
attributes, all React-escaped, so it is not an XSS vector as written. It would
become one if anyone ever routed it through `dangerouslySetInnerHTML`, a
`style="…"` value, or a URL/`href`.

**How to apply:** treat the Variants column heading as backend-controlled text.
Any new sink for `title` needs the usual untrusted-string treatment; plain JSX
text and attribute interpolation do not.

Related: [[neo137-platform-slots]] (same `selectorOptions.platformData` rows).
