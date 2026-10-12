---
name: neo334-sub-variants-column-is-role-gated
description: NEO-334 — a variant type's TITLE is its kind (Base / Insert(s) / Parallel(s), exact word, no flag), so hand-made types behave like synced ones; the seventh column (header "Parallels", `Add custom Sub-Variants`) renders only under an Insert type; how to tell column 6 from column 7, re-point the panel at the type, and the selectors the kind refusals render
metadata:
  type: reference
---

**The kind is the title (Jason, 2026-10-10; supersedes the flag rule this
note first recorded).** `variantTypeKind(row)` (convex/variantRole.ts) reads
the row's value after trim / whitespace-collapse / case-fold: `base`,
`insert`/`inserts`, `parallel`/`parallels`. No substring matching —
"Insert Set", "Base Parallels" have no kind. No `metadata.variantRole` /
`isBase` is read any more, so a type an operator TYPED ("Insert" via
util-drill-to-custom `VARIANT_TYPE`) is an Insert type exactly like a synced
one: Group Parallels and the seventh column are there. A flow proving nesting
no longer needs a synced fixture.

**What each kind changes on screen:**
- Insert type: picking an insert opens column 7 (`Sync Sub-Variants`,
  `+ Custom` = `id: "Add custom Sub-Variants"`, confirm `Create sub-variant`).
- Parallel type: no column 7; the `Parallels of <Base>` section mounts under
  the columns, and an insert's empty checklist shows the build stand-in
  (`Can't build yet` when the set has no Base) instead of `Fetch from
  Marketplaces`. That section lists hand-made rows as
  `<row> — skipped: not linked to a marketplace yet`, so a `.*<row>.*`
  pattern also matches (and taps) the section — use exact `text: "<row>"`.
- Base: terminal — no Variants column, the checklist (`Open add card form`)
  hangs off the type, the `Base set` tag sits in the attributes header, and
  on a hand-made set the Base mapping panel answers `Nothing to link yet…`
  with no round trip. A type becomes the Base by being RENAMED "Base".

**Refusals and where they render:**
- Custom-add of a singular/plural twin ("Insert" beside "Inserts"):
  EntityColumn refuses on Enter, before the confirm, in the form's alert
  (`…one word gets one row…`); then `id: "Cancel new variant type"`.
- Rename (attributes-panel pencil): a `<p role="alert">` under the header;
  the field STAYS OPEN holding the refused text, so tap the field itself and
  `eraseText` before typing the next name. Kind change with sub-variants →
  `…only live under an Insert type…`; second Base → `…already has a Base.`
  The one-Base check runs before the sibling clash.

**Re-pointing the attributes panel at the variant type.** The panel follows
the DEEPEST selection, and re-picking the selected type clears nothing below
it (handleVariantTypeSelect). Pick a different type, then come back: tap
`id: "Variant Types: <name> — change"`, tap/type into
`id: "Search variant types"`, tap `{text: <name>, below: {id: "Search
variant types"}}`. Gate every pick on its collapsed card before tapping
anything to its right (late collapse, [[columns-row-clip-and-late-collapse]]).

**Variants header handles.** `Sync <label>` / `Add custom <label>` /
`Search <label lower>` all derive from the header; `text: "<label>"` does
not prove the header because the collapsed Variant Types card shows the same
word. A title ending in "s" is not re-pluralised ("Inserts" → "Inserts"), so
util-drill-to-custom's `${VARIANT_TYPE}s` waits break for such titles —
create those types inline.

**Telling the two "Parallels" columns apart** (under a type titled
"Parallel", column 6 is titled "Parallels" too): column 7's buttons are
`Sync Sub-Variants` / `Add custom Sub-Variants`. After a row in column 6 is
picked it collapses to `Parallels: <row> — change` and its `Search
parallels` box is GONE, so from then on `id: "Search parallels"` can only be
column 7's; that box renders from frame 1, so it is the decisive negative.

Proved by `variant-type-title-is-its-kind.yaml` (hand-made) and
`bowman-sportlots-links-move-between-set-parallel-insert` claim 10 (synced).
See [[selected-column-collapses-to-card]],
[[negative-asserts-pass-on-a-dead-page]],
[[erase-text-needs-the-caret-at-the-end]].
