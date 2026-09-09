---
name: cross-release-import-modal-picker
description: "NEO-21 CrossListingImportModal is now a one-level-at-a-time BUTTON wizard (aria: Pick/Change/Filter/Use …) — fully Maestro-drivable, 6 levels in ~23s; plus the general rule for reaching a long option list inside a floating panel (inner overflow can't be scrolled → use the app's filter box, guarded by ONE cheap `when: visible`)"
metadata:
  type: reference
---

Supersedes the "NEO-21 modal is not E2E-drivable" finding in
[[maestro-web-driver-primitives]] §1a — the UI was rebuilt, the limitation there
still stands for native `<select>` stacks generally.

## Selectors (`components/SetSelector/CrossListingImportModal.tsx`)
All modal-unique — grep confirmed nothing else in `components/`/`app/` uses these
prefixes, so no `childOf:` scoping is needed even with the set-selector columns
showing the same words behind the modal.

| Thing | Selector |
|---|---|
| modal shell | `id: "Add cross-release cards"` (role=dialog) |
| step heading | text `Pick <Level>` / `Pick <Level> under <parent>` |
| filter box (only when a level has **>8** options) | `id: "Filter <Level> options"`; Enter picks the top match |
| an option | `id: "Pick <Level> <value>"`, node text = `<value>` |
| breadcrumb chip (already-picked level) | `id: "Change <Level>"`, node text = picked value → `{id, text}` is a precise "the modal heard X" assert |
| optional-stop | `id: "Use <parentValue> as the source set"` |
| confirmed source banner | text `Source set: <value>` |
| card numbers | `id: "Card numbers to cross-list"` |
| submit / cancel | `id: "Link cross-release cards"` / `id: "Cancel cross-release import"` |

`LEVEL_LABEL` maps `setName`→**Set** and `variantType`→**Variant**, so the two deepest
custom levels read `Pick Variant Insert` then `Pick Insert Base`.

**Level flow for the per-worker playground** (`E2E Test Sport N` → 2026 → Topps →
`<set>` → Insert → Base): answer all six; `parallel` under Base is empty so the modal
**auto-confirms** the insert by itself and shows `Source set: Base`. That banner is the
load-bearing return assert — `Link Cards` stays disabled until it appears, which also
means **Enter cannot submit before it** (browsers ignore Enter with a disabled submit).

## THE GENERAL RULE — long option lists inside a floating panel
`scrollUntilVisible` is `window.scrollTo` only, so an `overflow-y-auto` list inside a
fixed/portal modal **cannot be scrolled**, and maestro-web reports layout bounds for
CSS-clipped rows ⇒ a tap on a clipped row silently lands on whatever is drawn there.
Measured geometry for this modal at 1024×629: header 87 + footer 61 + step controls
~66 + card-number block ~78 + padding/gaps ≈ 340px fixed, modal capped at 85vh=534px
⇒ the list gets ~194px ≈ **4½ rows**. The app's own `FILTER_THRESHOLD = 8` therefore
does NOT match what fits: **5–8 options render no filter and can still clip.**

Pattern that works (used in `util-pick-cross-list-source.yaml`):
- levels whose option count is structurally 1–2 (a per-worker custom subtree's year /
  manufacturer / variantType / insert) → **plain `tapOn`**, no guard, no wait;
- levels whose length we don't control (Sport = whole catalogue ≈19; Set = every set
  the worker ever built) → **one `when: { visible: "Filter <Level> options" }` block**
  that taps the filter and types the value, then an unconditional `tapOn` the option.
  Filtering collapses the list to one row, which is always first and always on screen.
  Cheap when the filter is there (the normal case); costs one 7s miss on a sparse
  deployment, where the list is short anyway. Never add the mirror `when: notVisible`
  branch — that is a guaranteed 7s every run (see [[maestro-web-driver-primitives]] §5).

## Validated
2026-07-26, headless 1024×629 vs the shared dev deployment, all 4 green single-attempt:
card-appears-in-guest-checklist 5m12s · hide-toggle-filters-guest-cards 5m24s ·
import-reports-missing-numbers 4m52s · unlink-keeps-card-in-home-set 7m39s.
The 6-level modal drill itself is only **~23s**; the rest is the two page-level
`util-drill-to-custom` navigations. Option buttons land at y≈274–332 — safely clear of
the page's lower region, no `centerElement` needed inside the modal.

**Backend gotcha that broke a flow:** `addCrossListingsByCardNumbers` throws
`"Source set must be a variant-level set (Base/insert/parallel)"` for anything
shallower, so a flow that submits with only a Sport picked tests an unrelated
validation error, NOT the `notFound` path. Always drill to a real variant-level source
(an empty custom set is the clean "these numbers aren't here" fixture).
