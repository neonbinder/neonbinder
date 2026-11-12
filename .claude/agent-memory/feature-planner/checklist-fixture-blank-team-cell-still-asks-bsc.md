---
name: checklist-fixture-blank-team-cell-still-asks-bsc
description: A blank (or None/N/A/TBD/dash) team cell in a publisher's checklist makes no claim, so the fetch still asks BSC; write "No Team" for a card that has none (NEO-489)
metadata:
  type: project
---

A checklist row whose team cell is blank, or a whole cell of None / N/A / TBD / Unknown / ? / a dash, makes no claim (invariant 8), so `fetchCardChecklist` keeps that card's live BSC lookup. A card that truly has no team (a show or host card, a raffle entry card, an NFLPA promo) must read `No Team`: since NEO-489 that is a data claim, saved as a confirmed no-team, never looked up and never on "Cards with no team". The capture tool writes BSC's blank as blank, so `No Team` cells are hand-set and recorded in SET-REGISTRY. Card numbers in the number column are read as printed, any case (`PPR-DLa`, `a`, `TBD`); a number repeated in the file or set is still refused by rule 7.

**Why:** NEO-489 planning (2026-11-11): the Stars of MLB Network fixture's 10 blank cells cost 10 BSC lookups per fetch, and their burst drew the 429 that turned another spec red. Jason approved `No Team` as a checklist claim.

**How to apply:** when inventorying BSC calls, count `cards - teamsFromChecklist` from each fetch's `checklist_published_match` log line, not blank cells alone. Never leave a team cell blank in a fixture. Related: [[live-lookup-429-is-a-pass-converge-by-operator-pick]].
