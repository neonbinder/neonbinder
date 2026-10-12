---
name: reference-reaching-the-missing-team-fixer
description: How a flow honestly reaches MissingTeamFixer with career chips — a hand-added card linked to a catalogue player, no team; why the wizard's Skip path is not a route (and no longer yields a listing hint), and what stays unit-only
metadata:
  type: reference
---

**The honest path is a hand-added card** (NEO-330, 2026-10-12;
`set-selector/checklist-missing-team-fixer-hand-added-card.yaml`). Quick-add on
a per-attempt hand-made set under the REAL `Baseball › 2024 › Topps`, pick a
reference-catalogue player in the form's PlayerPicker, leave Team empty. No BSC
ref = no automatic team source, so `deriveCardAttention` badges `missingTeam`
at once. The walker's fixer then shows `Players: <name>` and, when no stint
covers the set year, the whole-career fallback: heading `No 2024 team on file —
here’s the whole career. Pick the one on the card.`, chips named
`<team> · <player> played here`, NOTHING preselected (hint `Pick at least one
team, …` is the perceivable proof). Pick a retired one-team player (catalogue:
George Brett, one stint, Kansas City Royals). Linking writes the CARD only;
the catalogue rows are never mutated.

**The wizard is not a route.** A team step has three exits — link (`Search all
teams`), `Add as New Team`, `Skip <name> — not a team` — and `Confirm & Save`
needs every row decided; there is no "leave it for the card". Skip is a false
operator statement ("not a team"), and a NEO-330 fix (2026-10-12) blocks the
old side effect where the skipped card went to the BSC per-card queue and came
back with a listing hint for the very name ruled not-a-team. Read the queue code
before assuming any Skip → hint route exists. Never build a flow on it.

**Unit-only:** the listing's era chips (`The listing names …`) need
`bscTeamName` + a known sport, written only by the background BSC lookup on a
marketplace-linked card. Ctrl/Cmd+Enter save: maestro-web `pressKey` has no
modifiers, and plain Enter is skipped on INPUT/BUTTON targets, so flows tap
`Save & Next` (same `save()`).

Related: [[reference-neo102-card-attention-walker]],
[[reference-catalogue-on-ci-previews]].
