---
name: neo219-confirm-surfaces
description: NEO-219 selectors — custom-entry now needs TWO Enters, the Base picker needs an explicit pick, chips confirm detach, and empty rows have a delete control
metadata:
  type: reference
---

# NEO-219 — the four surfaces that changed how a flow drives set-builder

Verified against source on branch `neo-219-mapping-confirms` (2026-09-04).

## 1. Custom entry is now TWO Enters, everywhere

`EntityColumn`'s custom form is a three-stage machine: `input` → `checking` →
`confirm-create` (or `confirm-exists`). The create confirm mounts with **Create
focused**, so the keyboard shape is `inputText` → `pressKey: Enter` →
`pressKey: Enter`. An Enter that lands while the cross-parent lookup is still in
flight is BUFFERED (`pendingCreateEnterRef`) and replayed onto the confirm, so
the second Enter is never lost to a race.

* Heading stays **`Add Custom Entry`** across all three stages — it still
  brackets the whole interaction, so `notVisible: "Add Custom Entry"` is still
  the "the row was written" gate.
* **The confirm sentence CONTAINS the typed value** (`Create set 'X' under
  2026 › Topps?`), so any gate of the shape `assertVisible: "<the value>"` can
  now pass while the form is still open. Gate on the form CLOSING first.
* Sentences: `Create {noun} '{v}' under {A} › {B}?` (breadcrumb is the last TWO
  ancestors, joined with `›` U+203A; no `under …` clause at root) /
  `'{v}' already exists under {A} › {B}` with `Go to it` (focused) /
  `Create here anyway` / `Back`.
* Typing a value that already exists **in the same column** still selects it
  with no confirm — `custom-field-known-value-selects.yaml` is that path and
  needs no second Enter.
* The cross-parent check only fires for `setName` (all brands under the year),
  `insert` and `parallel` (all variant types + inserts under the set). Sport /
  year / manufacturer / variantType are parent-scoped, so they always get the
  plain create confirm.
* Custom **years are now strictly `^\d{4}$`** — inline error
  `Year must be a four-digit number`. Any per-worker year suffix (`1975-w0`) is
  refused; isolate on the SPORT instead.

## 2. BaseSetPicker no longer picks for you

Pre-select happens only at score ≥ 950 (exact set name, or exact after the
manufacturer prefix is stripped); an exact MANUFACTURER match was demoted to 600,
below the generic `Base`/`Base Set` rows. The old auto-writes (SL empty → write
`bscOptions[0]`; both empty → write the set's own BSC slug) are gone — **there is
no auto-close path any more**, so "Path B" in the base flows means only "this row
was already mapped".

Rows are tappable by accessible name:
`SportLots base candidate: {value}` / `BSC base candidate: {value}` /
`BSC base candidate: {setName} — set listing (BSC)`. Both lists are sorted
best-first, so `id: "<side> base candidate: .*"` reliably taps the top-ranked
row without pinning a marketplace label.

Unchanged landmarks: `Select Base Set`, `SportLots base`, `BSC base`,
`likely match` (threshold still 795), `Confirm Base Set` (constant in initial
mode — only disabled), `Loading…` → `Confirm Base Set` as the marketplace-lands
signal, `Base mapping cancelled…` + `Retry`. Description changed to
`Choose the SportLots and BSC sets that hold {setName}'s base cards…` (curly
apostrophe — match the opening clause only).

The footer hint `Pick a SportLots or BSC set to continue.` is **not assertable**
in general: it is hidden whenever an exact-name SL row pre-selected itself.

## 3. Every source chip confirms detach, with a per-slot card count

`MultiSourcePanel`: one `×` per chip, `aria-label` `Remove {label}` (the
non-primary chip no longer detaches immediately). It becomes an inline question:
`Detach BSC "{label}"? {n} cards were fetched from it; their BSC link will be
dropped.` (`1 card …; its …`, `No cards were fetched from it.`, and
`Counting the cards fetched from it…` before the count lands; the primary chip
appends ` A later sync of this row could re-add it.`). Buttons carry
`Confirm detach {label}` / `Cancel detach {label}`.

The count query is subscribed at PANEL level, so it has resolved long before the
confirm opens. **Cancel with the Cancel button, not Escape** — the product
handles Escape, Maestro-web cannot send it.

## 4. One sanctioned delete, in the attributes header

`SetAttributesPanel`'s header (visible whether the panel is expanded or not, at
ANY selected level) has a bin after the rename pencil: `aria-label`
`Delete {value}`, then a `ConfirmDialog` titled `Delete {Level} "{value}"?` with
`Nothing is below it. This cannot be undone.` (+ ` It is linked to BSC; the next
sync may add it back.` when the row carries a marketplace id) and `Yes, delete` /
`Cancel`. Level noun comes from `LEVEL_SINGULAR` — `Sport`, `Year`,
`Manufacturer`, `Set`, `Variant Type`, `Insert`, `Sub-Variant`.

**While the holdings query is still in flight the bin is `aria-disabled` and a
press only REVEALS the reason** ("Checking what is below it…"), it does not open
the dialog. Wrap the press in `retry: maxRetries: 1` keyed on the dialog title —
a row that genuinely holds something fails both attempts, so R2 survives.

## 5. A flow that ADDS ROWS to a shared column breaks unrelated flows

Learned the hard way in PR #226 run 1. The set-selector columns start at y≈380
(the Admin Tools block is above them) and each row is ~58px, so at about the
FOURTH row a column's `Sync <X>` / `+ Custom` buttons fall past the bottom of the
1024×625 headless viewport. `util-drill-to-custom.yaml` waits for
`Add custom <X>` **without scrolling** at several levels (a deliberate guard
against a CDP crash during re-render), so once those buttons are under the fold
the drill cannot recover.

A new flow put two custom MANUFACTURER rows under the shared
`E2E Test Sport <worker>` › `2026` — which `util-drill-to-custom-set.yaml` pins
seven flows to — taking that column from one row to three and failing
`team-picker-create-custom-card`, a flow with no relationship to it. A custom SET
is free; a custom sport/year/manufacturer under a SHARED ancestor is not. Give
such a flow a **private sport**: the Sports column is long enough to render a
search input, every drill filters it first, and its list is capped by its own
`max-h-[400px]` scroller, so one more sport row is invisible to everyone.

Related: [[entitycolumn-custom-form-replaces-list]],
[[base-mapping-picker-paths]], [[maestro-web-presskey-and-popovers]].
