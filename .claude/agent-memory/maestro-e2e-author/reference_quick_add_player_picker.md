---
name: reference_quick_add_player_picker
description: Quick-add form PlayerPicker handles (create AND pick-existing) — `Add a player to the new card` → `Find a player for the new card` → `Create player X` / `Add X`; the row prints no player, so a drawer read-back is the only persistence proof; which flows own each path since NEO-335 retired Fill teams
metadata:
  type: reference
---

# Quick-add PlayerPicker (CardChecklist add-card form) — the handle sequence

Labels are `QUICK_ADD_PLAYER_LABELS` in `CardChecklist.tsx`, reworded (not
suffixed) so they share no substring with the drawer's defaults (`Add player`
/ `Search players`). Verified live 2026-09-14.

```yaml
- scrollUntilVisible: { element: { id: "Add a player to the new card" }, centerElement: true, timeout: 7000 }  # fold trap: Players row opens at y≈595
- tapOn: { id: "Add a player to the new card" }
- tapOn: { id: "Find a player for the new card" }
- inputText: "<Prefix><token>"
# new name  → id: "Create player <name>"   (players.findOrCreate + chip in one tap)
# existing  → id: "Add <name>"             (the result row; Create row is HIDDEN when a normalised exact match exists)
- extendedWaitUntil: { visible: { id: "Remove player <name>" }, timeout: 7000 }
- tapOn: { id: "Card name" }               # pointerdown outside closes the popover; it covers the Team row + Add/Cancel
- extendedWaitUntil: { notVisible: { id: "Find a player for the new card" }, timeout: 7000 }
```

Candidates are `players.list` scoped to the sport row (limit 500), filtered
client-side, so a per-attempt single-token name surfaces exactly one row.

**The row sub-line does NOT print the player** (`CardChecklistItem` subParts:
team · pending teams · print run · variation · …), and an unlinked card with
no pending name raises no badge either — so neither the row nor the badge can
tell a persisted pick from a dropped one. Read it back from the card drawer's
PlayerPicker chip (`Remove player <name>`), which is the drawer body's LAST
editable section: three `swipe: {start: "80%, 80%", end: "80%, 20%"}` touch
drags reach it, and they chain to the window, leaving the PAGE at maximum
scroll (every later scroll is UP).

Owners (NEO-335 retired `set-fill-teams-from-teammate-card`, which used to
carry both paths):
- quick-add CREATE + drawer read-back → `checklist-attention-badge-and-filter`
  card 3 (`CNAP<token>`);
- quick-add pick EXISTING (`Add <name>`, `Create player` asserted absent) →
  `admin/player-sports-multi-sport-membership`; via the sport switch →
  `card-player-picker-cross-sport`;
- drawer create → `player-picker-create-custom-card`.

Related: [[reference-quick-add-form-teampicker-neo208]],
[[patterns-exact-match-proof-is-the-demoted-create]].
