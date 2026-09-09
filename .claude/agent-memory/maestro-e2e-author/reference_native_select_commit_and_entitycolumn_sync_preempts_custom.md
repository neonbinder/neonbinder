---
name: native-select-commit-and-entitycolumn-sync-preempts-custom
description: Two CI-only set-selector races RCA'd on NEO-71-74 — controlled native <select> needs pressKey Enter to commit (type-ahead in an OPEN popup fires no onChange), and EntityColumn's newPathContent rendered the "Syncing… Fetching from marketplaces" panel BEFORE the open custom-entry form, unmounting the customvalue input mid-type under CI concurrency (stale element reference)
metadata:
  type: reference
---

Two DISTINCT CI-reproducible flakes on `set-selector_card-autograph-always-visible-saves`
(passed locally every time, failed 2/2 CI as two DIFFERENT failures). Both fixed at source.

## FLAKE B — controlled native `<select>` needs an explicit commit key on CI
`FeatureValueControl.SelectValueControl` renders a CONTROLLED `<select value={selected}>`
(`selected` derives from `card.features.autographed` via Convex). The displayed value only
flips AFTER onChange → setCardFeature mutation → Convex reactivity pushes the value back.

- On CI (headless chrome 150 + selenium/chromedriver), `tapOn` a native `<select>` can leave
  the browser's OPTION POPUP OPEN. While the popup is open, type-ahead (`inputText: "O"`) only
  MOVES THE HIGHLIGHT — the `change` event does NOT fire until the selection is COMMITTED.
  → no onChange → no setCardFeature → controlled value stays "None" → the "On Card"
  `extendedWaitUntil` burns its full 7s and fails. Screenshot proof: popup open, "On Card"
  highlighted, but getNodeText (=selected option) still "None".
- **Fix: add `- pressKey: Enter` between the `inputText` and the value assert.** Enter commits
  the highlighted option, fires `change`, runs setCardFeature. Validated: does NOT reopen a
  popup that breaks the subsequent Cancel tap (full change→Cancel→reopen→delete cycle passed 2/2).
- `signed-by-autofills-from-players` survives the SAME select only INCIDENTALLY: its normalise
  cycle does a SECOND `tapOn` (None→tap→O), and that second tap closes any stuck popup before
  the committing type-ahead. A single tap+type has no such popup-close — that's the trap.
- Does NOT reproduce locally (parallelism=1) — local tap apparently doesn't leave the popup open.
  So a green local run only proves NO-REGRESSION, not the CI fix. Reason from the code + CI
  screenshot, don't wait for a local repro.

## FLAKE A — EntityColumn syncing panel preempts the open custom-entry form
`EntityColumn.tsx` `newPathContent()` (the NEO-47 `useEnsureSync` path — Sports/Years/etc.)
ORDERED the checks: `if (syncStatus==="syncing") return <Syncing panel>` BEFORE
`if (mode==="custom") return customForm`. So when a BACKGROUND re-sync flipped syncStatus to
"syncing" while the operator had the "Add Custom Entry" form open, the component swapped the
form out for "Syncing… Fetching from marketplaces…", UNMOUNTING the `mb-field-*-customvalue`
`<input>` mid-type → maestro's element handle went stale → `stale element reference` on the
`inputText: <SPORT>` in `util-drill-to-custom` (sport-creation branch). Also a real UX bug:
a half-typed custom value is silently discarded on any background sync.
- CI-specific trigger: 8 shards on ONE shared dev Convex churn the GLOBAL selectorOptions
  catalog → background re-syncs fire constantly; local parallelism=1 is quiescent while typing.
- Hits whichever flow FIRST creates the per-worker `E2E Test Sport <N>` (write-once catalog,
  reset never wipes it) — NOT specific to card-autograph; a shared-util-wide race.
- **Fix (product): reorder so `if (mode==="custom") return customForm;` comes FIRST**, before
  the syncing branch. Once the user opens "+ Custom", a background sync never yanks the form.
  The legacy (`useEnsureSync` false) path already had custom-form precedence — only the new
  path was wrong. EntityColumn tests stay green (8/8).

## Debugging note
The prior fix round mischaracterized FLAKE A as "transient maestro-web re-render race … did
not recur locally" and left it. Two CI failures were TWO ROOT CAUSES, not one flake. Always
pull the failing runner's junit `<failure>` msg AND screenshot from EACH failed run — the two
runs failed at different steps (32s stale-element vs 149s select-commit).
