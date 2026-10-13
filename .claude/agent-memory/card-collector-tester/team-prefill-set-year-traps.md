---
name: team-prefill-set-year-traps
description: Hobby traps for any feature that pre-fills a card's team from a player's career stints and the set year (NEO-335 teams step review, 2026-10-10)
metadata:
  type: project
---

Pre-filling a card's team from career stints + set year goes wrong in predictable hobby cases. Check every such rule against these:

- **Set year is not the season.** A 2026 flagship Series 1 card shows the 2025 team; an offseason trade (new stint fromYear = setYear) pre-fills the NEW team on a card printed with the old one. In-year window should be [setYear-1, setYear]; a tie stays unselected.
- **"One-team career" is not "one team on the card".** Enrichment often lacks the college stint, so a draft-product rookie (Prizm Draft Picks, Contenders Draft, Bowman U, Leaf Draft) pre-fills the pro team on a college-uniform card. Only shortcut when the lone stint covers the set year.
- **Prospects card to the MLB org, not the affiliate** (Bowman); dealers sell "Pirates prospects".
- **Retired legends on modern inserts** have no in-year stint: offer the whole career unselected, never guess (Ruth = Yankees AND Red Sox).
- **Same player, different teams in one set** (Update/Traded, Highlights, multi-stint inserts): a per-player grouped answer must be splittable per card.
- **Multi-player cards** (League Leaders, Rookie Stars) need several teams; a single-select radio over individual teams cannot express that.
- **Team checklist / team cards** have no player, so player evidence gives nothing; the line needs a team search, and "No team on this card" is wrong for them.
- **Team-issued minor-league sets** (ProCards, Best, Grandstand) are one team for the whole set: point at the set-level team, not 30 lines.

How to apply: when reviewing any teams/stints pre-fill, walk these eight cases before the copy. Related: [[neo102_reconcile_no_team]], [[collectors-collect-by-alma-mater]].
