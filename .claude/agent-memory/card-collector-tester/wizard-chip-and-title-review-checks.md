---
name: wizard-chip-and-title-review-checks
description: Recurring collector-review checks for chip pickers and generated listing titles (round livery dot reads as a radio; core cut must never eat player names; clip meter noise on a trim step)
metadata:
  type: feedback
---

Checks that surfaced in the NEO-335 built review (2026-10-11) and apply to any chip picker or title generator:

- A round team-colour dot inside a single-select chip reads as a filled radio button: a red dot looks "selected" next to a navy one. Use a square/bar swatch, or colour the team name itself, and keep the check mark as the only selected cue.
- A title's core cut at a word boundary from the END removes the player tail first (surname, suffix, second player). Player names and #number are the search terms; set-name words should give way first. Suffix-only protection is a patch, not the rule.
- On a screen whose cards are there BECAUSE they were trimmed to 80, a 70+ "may clip in search" band fires on every row and is noise. Warn only on over-limit there.
- Pre-fill rules that drop a year-blind one-team-career answer (to protect college draft cards) cost a click on every one-team legend; gating that answer on the team ranking in the set's league is the cheap middle ground. See [[team-prefill-set-year-traps]].
- Playerless cards (checklists, leaders, team cards) each get their own line when grouping is by player set; a vintage set has dozens. Ask whether they can share one line.

**Why:** each of these looked fine in the code review but costs a collector clicks or a wrong listing on every set.
**How to apply:** run these on any team/parallel chip picker and any title-generation or trim UI.
