---
name: reference_quick_add_player_picker_and_fill_teams
description: Quick-add form PlayerPicker handles (create AND pick-existing, verified live 2026-09-14) and the NEO-279 Fill teams control's selectors — the trigger has NO aria-label so it is `text:` not `id:`, the ledger row is four separate text-node spans, and the confirm/toast strings are exact counts
metadata:
  type: reference
---

# Quick-add PlayerPicker (CardChecklist add-card form) — the handle sequence

`set-fill-teams-from-teammate-card.yaml` is the first flow to drive it. Labels
are `QUICK_ADD_PLAYER_LABELS` in `CardChecklist.tsx`, reworded (not suffixed)
so they share no substring with the drawer's defaults:

```yaml
- scrollUntilVisible: { element: { id: "Add a player to the new card" }, centerElement: true, timeout: 7000 }  # fold trap, same as Add team
- tapOn: { id: "Add a player to the new card" }
- tapOn: { id: "Find a player for the new card" }
- inputText: "FTP<token>"
# new name  → id: "Create player FTP<token>"   (players.findOrCreate + chip in one tap)
# existing  → id: "Add FTP<token>"             (the result row; Create row is HIDDEN when a normalised exact match exists)
- extendedWaitUntil: { visible: { id: "Remove player FTP<token>" }, timeout: 7000 }
- tapOn: { id: "Card name" }                   # pointerdown outside closes the popover; it covers the Team row + Add/Cancel
- extendedWaitUntil: { notVisible: { id: "Find a player for the new card" }, timeout: 7000 }
```

Candidates are `players.list` scoped to the sport row (limit 500), filtered
client-side, so a per-attempt single-token name surfaces exactly one row. All
of this settled at ~0.6s per scroll / ~2s per tap in the 2026-09-14 local run.
The row sub-line does NOT print the player, only teams — the player is proven
by the chip, or (post-fill) by the Fill teams ledger.

# NEO-279 Fill teams (SetAttributesPanel header, setName level only)

- **Trigger**: `text: "Fill teams"`, NEVER `id:` — the button has no
  aria-label (its text is the name and flips to "Checking…") and carries a
  DOM id `fill-teams` for the driver's pressKey re-find only. Reachable while
  the panel is collapsed; centres in one swipe thanks to the NEO-260 spacer.
- **Confirm** (`ConfirmDialog`, fixed, centred): title
  `Fill teams on N card(s)?`; body from `fillConfirmCopy` — for rule A
  `N from the same player's other cards here.` (+ `M still need(s) your
  call.` only when M>0); confirm `Yes, fill`, sibling `Cancel`.
- **Ledger**: `role=group` with `id: "Who gets which team"` (max-h-60 inner
  scroller — assert only what is in its visible slice). Each row is FOUR
  spans, each its own text node: `<player names " & ">`, `→`,
  `<team full names " / ">`, `· N card(s) · <rule clause>`. Rule A own-node
  clause is `same player in this set`; cross-node appends ` · <node names>`;
  B is `only team on file`; C `only team in <year>` / `only team that year`.
  Match the middot as `.`.
- **Toast** (panel's fixed status toast, 6s): `Filled teams on N card(s)`
  (+ ` · K changed under you and was/were skipped` when K>0). Zero-fillable
  path is a toast, no dialog.
- Candidate = linked player(s) + no `teamOnCardIds` + no pending team name +
  no "no team" confirmation (+ BSC-ref cards wait for `teamCheckDoneAt`), so
  a hand-added card with a picked player and an empty Team row qualifies, and
  a set-level team (NEO-277) must NOT be set on the fixture — it would be
  copied onto every card at birth and leave nothing to fill.

Strings above were read from the working tree mid-build (a sibling builder
was still editing `FillTeamsControl.tsx`); re-verify against the merged
component before trusting them.
