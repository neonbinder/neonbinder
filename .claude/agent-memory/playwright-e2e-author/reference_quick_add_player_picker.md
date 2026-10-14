---
name: reference_quick_add_player_picker
description: Quick-add form PlayerPicker handles (create AND pick-existing) — `Add a player to the new card` → `Find a player for the new card` → `Create player X` / `Add X`; the row prints no player, so a drawer read-back is the only persistence proof
metadata:
  type: reference
---

# Quick-add PlayerPicker (CardChecklist add-card form) — the handle sequence

Labels are `QUICK_ADD_PLAYER_LABELS` in `CardChecklist.tsx`, reworded (not suffixed) so
they share no substring with the drawer's defaults (`Add player` / `Search players`).
Verified live 2026-09-14.

1. Scroll `Add a player to the new card` into view (the Players row opens low in the
   form) and click it.
2. Click `Find a player for the new card` and type `<Prefix><token>`.
3. New name: click `Create player <name>` (players.findOrCreate + chip in one click).
   Existing: click `Add <name>`; the Create row is HIDDEN when a normalised exact
   match exists.
4. Expect the chip `Remove player <name>`.
5. Click the `Card name` field: a pointerdown outside closes the popover, which covers
   the Team row and Add/Cancel. Expect `Find a player for the new card` gone.

Candidates are `players.list` scoped to the sport row (limit 500), filtered
client-side, so a per-attempt single-token name surfaces exactly one row.

**The row sub-line does NOT print the player** (`CardChecklistItem` subParts: team ·
pending teams · print run · variation · …), and an unlinked card with no pending name
raises no badge either, so neither the row nor the badge can tell a persisted pick from
a dropped one. Read it back from the card drawer's PlayerPicker chip (`Remove player
<name>`), the drawer body's LAST editable section.

Coverage after NEO-335 retired Fill teams (which used to carry both paths):
- quick-add CREATE + drawer read-back: the attention-badge spec, card 3;
- quick-add pick EXISTING (`Add <name>`, `Create player` asserted absent):
  `admin/player-sports-multi-sport-membership`; via the sport switch:
  `card-player-picker-cross-sport`;
- drawer create: `player-picker-create-custom-card`.

Related: [[patterns-exact-match-proof-is-the-demoted-create]].
