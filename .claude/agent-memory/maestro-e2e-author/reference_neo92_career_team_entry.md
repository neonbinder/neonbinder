---
name: reference-neo92-career-team-entry
description: NEO-92 follow-up CareerTeamEntry (manual career-team add on a wizard PLAYER row) — E2E surface, chip assert, no-op validation trick, and the persisted-state assertion GAP (sport-casing split)
metadata:
  type: reference
---
> **STALE FLOW NAMES (2026-09-05).** Every `checklist-fetch-*` /
> `checklist-keyboard-only-dialog` flow named below was DELETED in NEO-220/221 —
> quick-add's Players field is a PlayerPicker, so a custom subtree can no longer
> produce an unknown name. The wizard mechanics here are still accurate; the flow
> names are history. See [[reference-neo220-wizard-only-from-real-fetch]].

NEO-92 follow-up: `components/SetSelector/CareerTeamEntry.tsx` renders inline in
`EntityReviewWizard` ONLY for a player row (`current.kind === "player"`, and only
when `linkingOpen` is false). Lets the admin hand-add `{team, fromYear, toYear?}`
career history IN ADDITION to Wikidata's, staged in the wizard and sent with the
`recordDecision({action:"create", manualCareerTeams})` on "Add as New Player".

**Surface (all Maestro-targetable):**
- Section label `<p>` text: `Add career team history manually (optional):`
- Team name combobox aria `Career team name` (free-text; typing a non-match is
  valid → new team at commit; suggestion dropdown only if the sport's team pool has
  a substring match — routinely empty on baseball, so none appears — that's fine).
- `From year` (type=number), `To year (optional)` (aria has literal parens →
  `id: "To year \\(optional\\)"`).
- `Add career team` = the "+ Add" button, disabled until name non-empty AND
  fromYear valid (integer, 1869..currentYear+1; toYear if set >= fromYear).
- On valid add: form clears + focus returns to name; a chip appears in
  `<ul aria-label="Staged career teams">`. Chip text = `{name} ({from}–{to})` or
  `{name} ({from}–present)` (EN-DASH U+2013 — match the dash with `.`). Per-chip
  remove aria `Remove {name}`.

**Flow: `set-selector/checklist-fetch-wizard-add-career-team.yaml` (green ~3m28s,
tags set-selector+regression).** Same skeleton as
`checklist-fetch-unknown-entities-link-existing`: per-worker custom set
`cte-${WORKER_INDEX}` under REAL Baseball/2024/Topps (isCustomSubtree → wizard opens
only from THIS worker's own custom-card pending player name; sport derives to
"baseball"). Private Step-1 self-heal pre-clean, add a card with unique player
`CareerPlayer-${ATTEMPT_ID}`, fetch → wizard on that player row.

**No-op validation assert (the reusable trick):** type ONLY the team name, tap the
disabled `Add career team` → assert the name is STILL in the input
(`{id:"Career team name", text:".*<name>.*"}`, since a successful add clears it) +
`assertNotVisible {id:"Staged career teams"}`. A disabled button tap is a harmless
no-op in maestro-web; this proves garbage isn't silently accepted. Then add the
fromYear/toYear and re-tap to get the chip.

**PERSISTED-STATE ASSERTION GAP (reported to owner, NOT worked around):** the staged
team IS persisted at commit (resolveTeamIdByName get-or-creates it into `teams` +
attaches to the new player's `teamYears`, selectorOptions.ts ~L4001-4065) but is
NOT assertable in-UI: (a) no page renders a player's teamYears anywhere; (b) the
inverse check (open the card's TeamPicker, find the new team as an existing row)
FAILS on a **sport-casing split** — commit creates the team with `sport="baseball"`
(lowercased ancestor, selectorOptions.ts:3459) while CardDetailPanel's TeamPicker
queries `teams.list({sport: ancestorSport})` with the RAW `"Baseball"`
(CardChecklist.tsx:79) → "baseball" ≠ "Baseball" → created team never in the pool.
(Same casing hazard already noted for link-existing's PlayerPicker "+ Create"
seeding.) So the assertable CEILING = wizard chip + successful advance + clean
"Saved 0 cards" (which also proves the staged entry round-trips recordDecision's
server re-validation AND commit's team get-or-create without throwing). Any real
persist assertion needs a PRODUCT change (a career-history UI surface, or aligning
the two sport casings).
