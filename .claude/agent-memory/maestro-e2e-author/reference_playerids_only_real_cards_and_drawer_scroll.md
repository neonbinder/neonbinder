---
name: playerIds only on real cards + CardDetailPanel drawer scroll gotchas
description: cardChecklist.playerIds ONLY exist on real marketplace-synced cards (custom cards never get them); the CardDetailPanel drawer's inner scroll can't be driven by Maestro center-swipe; native <select> type-ahead works; card #300 = Julio Rodriguez stable target
metadata:
  type: reference
---
Discovered while adding E2E for the NEO-24 `setCardFeature` autographed→signedBy auto-fill
(`.maestro/flows/set-selector/signed-by-autofills-from-players.yaml`).

## cardChecklist.playerIds ONLY exist on REAL marketplace-synced cards
`commitCardChecklist` (convex/selectorOptions.ts) resolves `playerIds` ONLY for the cards in its
fetch preview (`out`), which is built purely from BSC/SL marketplace rows. A CUSTOM card added via
`addCustomCard` stores player names in `pendingPlayerNames`; the commit's custom-card passes only
(a) fix sortOrder and (b) CLEAR `pendingPlayerNames` once the player entity exists — they NEVER write
`playerIds` back onto a custom row. `fetchCardChecklist` for a fully-custom subtree returns early with
`unknownPlayers:[]`, so a custom set's sync surfaces nothing. **Net: a per-worker custom card can never
acquire playerIds.** Any feature that reads `card.playerIds[]` (e.g. the signedBy auto-fill) can ONLY be
exercised on a real synced card (real 2024 Topps Chrome Base, pre-synced+player-confirmed by setup.yaml).
The CardDetailPanel "Players" section is READ-ONLY ("Add players via the marketplace fetch flow") — there
is no UI to attach a player to a card.

## Editing a real Base card = sole-writer tolerance (like topps-chrome-add-feature)
No other flow writes a real Base card's `autographed`/`signedBy` FEATURES (commitCardChecklist patches
real cards' playerIds/attributes/sortOrder but never their `features` map). Only one instance of a given
flow is enqueued per run, so a real-Base feature flow is the sole writer of its chosen card's autographed/
signedBy → safe. Restore autographed to "None" at the end; signedBy can't be cleared via UI (empty commit
is a no-op in useReactiveField) so it's left holding the player name — inert leftover, re-seed a sentinel
over it at the start of the next run.

## CardDetailPanel (right-anchored drawer) inner scroll — Maestro center-swipe CANNOT drive it
The drawer is `sm:w-[30rem]` (480px) anchored right; at the 1024px CI viewport it occupies x≈544–1024.
Maestro's `scrollUntilVisible` swipes from the VIEWPORT centre (x≈512), which lands on the BACKDROP (left
of the drawer) and does NOT scroll the drawer's inner container — so any element BELOW the drawer fold
(e.g. the read-only "Players" section, position ~9) is UNREACHABLE that way. Fix: a MANUAL swipe INSIDE
the drawer's x-range lifts its content, e.g. `- swipe: {start: "80%, 60%", end: "80%, 38%"}`. React
preserves the container's scrollTop across the per-row re-renders our edits trigger, so ONE swipe holds
for the whole sequence. Elements already visible after expanding the editor (Autographed y≈512, Signed By
y≈565 — both above the drawer's own sticky Cancel/Save footer at y≈599) can be tapped directly; the
page-level edge risk (R8) does NOT apply inside the drawer (it overlays the page at higher z).

## Native <select> feature controls: type-ahead WORKS in maestro-web (confirms the workaround)
Autographed / League / Era / Short Print render as native `<select>` (SelectValueControl). To change one:
`- tapOn: {id: "Value for Autographed"}` then `- inputText: "O"` (option's unique first letter) → the
browser's type-ahead selects the option and fires onChange → setCardFeature. Confirmed end-to-end (None→
"On Card" via "O", →"None" via "N"). A `<select>`'s getNodeText = its SELECTED option, so assert with a
combined `{id:"Value for X", text:"On Card"}`. This is the first suite flow that CHANGES (not just reads) a
select feature.

## Stable real-card target: 2024 Topps Chrome Base card #300 = "Julio Rodriguez"
A single-player card in the immutable set → reliably carries playerIds, and its player name is KNOWN
(assert `.*Julio.*` — robust to surname accent). Card #1 / top-of-list cards are NOT reliably reachable:
react-virtuoso does not deterministically mount at the top after the drill's page-scrolling, and a DOWN
scroll walks to the BOTTOM — so target a bottom card (#300) with a DOWN scroll (30s timeout).

## Local pick-harness does NOT run the setup track → real Base checklist can be empty
`npm run test:e2e:pick` auto-includes only worker-bootstrap, not setup.yaml (which pre-syncs+player-
confirms the shared Base checklist). On shared dev the Base checklist is sometimes empty
("No cards in this checklist yet."). Make a real-Base flow self-sufficient with a guarded fetch-if-empty:
`when: visible "No cards in this checklist yet."` → tap "Fetch from Marketplaces" → confirm the
UnknownEntitiesDialog (`.*Confirm [0-9]+ & Save.*|Skip All & Save`) → this saves real cards WITH playerIds.
In CI the setup track has already populated it so the guard is SKIPPED.
