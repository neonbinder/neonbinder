---
name: feedback-team-location-is-any-place-including-a-school
description: Team `location` is wherever the team is from — city, state, region OR school; never write that colleges/national sides "have no location"
metadata:
  type: feedback
---

A team row's `location` is **wherever the team is from**: a city, a state, a
region, or a school. "Wisconsin" / "Badgers". "San Diego State" / "Aztecs".
"Tampa Bay" / "Buccaneers". "Golden State" / "Warriors". Location is blank
ONLY when the name carries no place at all — the place *is* the name
("Liverpool"), the club word leads ("FC Dallas", "Sporting Kansas City"), the
club's own name leads ("Real Salt Lake"), or there is none ("Athletics",
"Orix Buffaloes"). Never write, in code comments, help copy or docs, that
"colleges / national teams / corporate-named clubs carry none" — colleges very
much do, and a sport suffix ("Aztecs men's basketball") stays with the **Name**.

**Why:** Jason, 2026-09-05, correcting NEO-236 (PR #233): `"leave Location
blank for a college." is the wrong thought. This is why I wanted to change city
to location. So it would be Location: Wisconson Name: Badgers, not Name:
Wisconsin Badgers`. Labelling the field "City" was already what made operators
leave it blank for Tampa Bay / New England; the "colleges have none" framing
recreated exactly that failure one level up. The branch's *code* was fine — no
path guesses a location without a source — but a dozen comments and the runbook
taught the wrong rule, and comments are what the next operator and the next
agent read.

**How to apply:** whenever touching `teams.location`, `splitTeamName`,
`teamRowFields`, the seed dataset, the split-locations runbook, or any
Location/Name form (TeamManagement, TeamPicker, EntityReviewWizard,
CareerTeamEntry). Also when an ESPN/marketplace lookup yields no location: that
is an **unsplit** row for an operator to split, not a claim the team has no
place — `skipped_no_source` means ESPN's league lists don't carry college/NPB
sides, nothing more. Related: [[external-ids-must-be-verified-live]].
