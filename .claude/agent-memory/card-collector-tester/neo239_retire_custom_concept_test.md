---
name: neo239-retire-custom-concept-test
description: NEO-239 manual test pass findings (2026-09-04) — set-builder base-role UX, Multi-source panel gating, minor copy nits.
metadata:
  type: project
---

Manual test of PR #227 (NEO-239 "retire the custom concept") on Vercel preview
<preview-slug>, 2026-09-04. All 7 checklist items passed with no
functional defects. Key behavioral facts worth remembering for future
set-builder work:

- **"Multi-source sets" panel (Attach more…) only renders when the selected
  variant type is marked as the base set** — not for the Set row itself, and
  not for non-base variant types (Insert/Parallel). This is true for both
  real (Topps Chrome) and hand-made trees. Before NEO-239 this panel was
  additionally hidden for hand-made/"custom" rows even when marked base —
  that's the bug this PR fixed. If a future ticket asks to "add the attach
  panel to every row," confirm whether they actually mean "every base-marked
  row" — the current design deliberately keys the panel off the base role,
  not off set-vs-variant.
- Renaming a variant type (pencil icon in the "Attributes for X" bar) is
  allowed for both Base and non-base variant types, on both real and
  hand-made trees. Renaming away from the marketplace-sourced name bumps the
  "N suggestion(s)" count on Sync (e.g. Insert→"Inserts X" went from 1→2
  suggestions), which is correct additive/suggestion behavior per the
  product invariant — not a silent overwrite.
- Mark/Clear base set: toast text is exactly "Marked <name> as the base set"
  / "Cleared the base set". Keyboard focus moves to "Clear base set" after
  marking and to "Mark as base set" after clearing (verified via
  document.activeElement, not just visually) — correct, and the button has
  `focus-visible:ring-2 ring-[#00D558]` so keyboard users get a visible ring
  (a mouse click doesn't trigger `:focus-visible` per spec, so no ring shows
  for mouse interaction — that's expected browser behavior, not a bug).
- The "+ Custom" add flow is two-step: typing a value shows a generic "Add
  Custom Entry" panel, pressing Enter swaps it for a confirmation
  ("Create variant type 'X' under Topps › pp-0?" with Create/Back buttons,
  focus on Create), and a second Enter commits. Works identically on hand-made
  trees.
- Hand-made columns (Years/Manufacturers/Sets/Variant Types) render their
  values instantly with no "Syncing…" spinner and no "Sync failed" state —
  confirmed on E2E Test Sport 0 → 2026 → Topps → pp-0.
- No "BuySportsCards skipped…" notice appears on a real year's Manufacturers
  column (2024) since BSC has no manufacturer level — confirmed absent.
- Checklist "Fetch from Marketplaces" button is contextual: it reads "Fetch
  from Marketplaces" when the checklist is empty (new base-marked variant
  with 0 cards) and "Refresh" when cards already exist (Topps Chrome Base,
  335 cards). Same underlying action, label depends on state — not a defect,
  but worth knowing so a ticket referencing "Fetch from Marketplaces" isn't
  misread as missing when a populated set shows "Refresh" instead.
- Attach-more dialog per-source empty/skip copy: BSC pane says "Every BSC
  variant in this set is already attached. Browse all 2024 sets to reach
  another set." when nothing is attachable; SportLots pane says "SportLots
  files set and variant as one, so every set here is attachable." Unattached
  base multi-source panel empty state is "No sets attached." for both BSC
  and SportLots columns.
- Delete-row affordance (trash icon, NEO-219) sits immediately right of
  "Clear base set" in the attributes bar — both are small text/icon controls
  right next to each other. Confirmation dialog reads 'Delete Variant Type
  "X"? Nothing is below it. This cannot be undone.' Minor UX nit: the two
  controls are close enough to misclick, especially on a touchscreen at a
  card show; consider more visual separation.
- Minor copy nit (low priority): the searchable-list column title naively
  appends "s" to whatever the variant type is currently named — renaming
  "Insert" to "Inserts X" produced a column titled "Inserts Xs" (double
  pluralization). Cosmetic only.

See also [[neo-211-selector-sync-review-spec]] for the related suggestions
UX this build on top of.
