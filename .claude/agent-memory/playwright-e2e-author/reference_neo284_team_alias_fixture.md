---
name: neo284-team-alias-fixture
description: NEO-284 team-alias E2E — since NEO-330 the one-sided 1996 Line Up Venezuelan Winter League fixture (300 cards, 8 unknown clubs, one club acted on BY NAME; the older Rickwood fixture and its SportLots picker CANCELLED path), how the "remember as alias" checkbox is asserted, the decision read-back, the wizard's TWO "Cancel (Esc)" controls, the NEO-326 team-step shape, and the wrong-SportLots-slot recovery via the MultiSourcePanel chip
metadata:
  type: reference
---

# NEO-284 — `checklist-wizard-link-team-saves-alias` facts (2026-09-16)

**Fixture (since NEO-330):** Baseball > 1996 > All Brands > *Line Up Venezuelan Winter
League* > Base, BSC only, through the fetch-to-wizard helper. 200 players + 8 clubs
unknown; 211 rows settle (a staged league + 2 staged career teams) after ~144 s of LIVE
lookups. All 211 are now in the NEO-289 recording, so re-measure the settle time from CI
(see [[record-a-fixture-sets-lookups]]). The walk reads every team/league heading and acts
on one checklist club BY NAME (Navegantes, an alias link), skipping the rest; branching on
the heading text is free in a Playwright spec. The past-era claims (Tigres, the catalogue's
single `Pittsburgh Crawfords`) moved to the past-era team-link spec, see
[[past-era-team-fixture]]. The alias-clash holder (`Pca`) now lives on the minted `Loc Ali`
team. Until NEO-330 the fixture was the 4-card Rickwood Field set below, whose clubs the
reference catalogue now holds; the Rickwood history follows.

Rickwood history: Baseball > 2024 > Topps > *Topps MLB at Rickwood Field Negro Leagues
Collection* > Base. BSC: 4 cards on Negro League clubs; 8 unknown names = 4 players +
clubs + ONE staged league ("Negro league baseball", presented FIRST: skip it with the
`Skip ... has no league` control, then the first team row follows).

**It is ONE-SIDED: cancel the base picker.** (Rickwood history:) SportLots did not carry the set; the
picker's SL column is the year's whole catalogue with "Base Set" flagged "likely
match" (2024 Topps flagship, 352 cards). Taking the first-candidate path
(`drillToBaseVariant`) attaches that wrong set and pairs 0 of 4. Cancel, "Base mapping
cancelled", Close, "Map Base Set", Sync, then the NEO-255 solo path ("Kept all N cards
from BSC"), no Match Cards dialog, so `fetchChecklistToWizard` cannot be used as is
(hand-roll the sync like the one-marketplace-skips-match-dialog spec).

**Recovering from a wrong SportLots slot on a preview:** the `MultiSourcePanel` chip
(`Remove <label>` then `Confirm detach <label>`) takes the slot off; the picker
auto-reopens (unmapped again) and the set is back to the fresh-sync shape. No reseed.

**Asserting the checkbox is ON:** assert the effect rather than the box (a checkbox's
value reads "on" either way in the old driver; in Playwright `toBeChecked()` works but
the effect is the stronger proof): the decision line `Linked to <team> · remembered as
“<row>”` is composed by `describeDecision` ONLY when `decision.saveAsAlias` is true on a
team link. Read it back with the `Back to previous decision` control after the link
(the wizard walks on immediately), then the `Decision for <row name>` group's text; then
`Next` resumes.

**The row's raw name is read off its heading** (`New Team: <name>`) with `textContent()`
and a string strip: the alias claim is "the checklist's spelling, exactly", so no club
name is hard-coded.

**A hand-staged career team's "New Team:" step waits on the deployment-wide Wikidata
pool** (`maxParallelism: 5`, FIFO across every shard): with two Big League batches (88
rows each) just queued by other shards, the staged row stayed "1 still being looked up"
past 30 s. Assert the `still looking up` text going away with the sanctioned 180 s
external-exception timeout (GUIDE hard rule 3, commented at the site) between the 7 s
"stage landed" wait and the 7 s step wait.

**Two "Cancel (Esc)" controls while the link search is open:** the search panel has its
own (`Cancel linking`), and a bare `getByRole("button", { name: "Cancel (Esc)" })` can
resolve both (strict-mode error). Close the panel first, or scope to the footer.

**The wizard's counter counts EVERY decision:** after a league skip plus a team link it
reads "2 of N", so never wait for "1 of N" after the link; wait for the row's heading to
go (`New Team: <row>` hidden) instead.

**Team Management after the commit:** filter by the single token, open the row by its
printed short name, then reach `Also known as`. The alias is on screen twice (the
textarea VALUE and the chip); the `Current aliases` list is the chip list's presence.
Empty textarea: `toHaveValue("")` is the positive for "gone".

**NEO-326 team-step shape (2026-10-04):** `Search all teams` sits in an ALWAYS-ON bordered
section headed `Link to existing team` (players/leagues keep "Possible matches") and
starts EMPTY (placeholder `Type a team name`): assert `toHaveValue("")` on the labelled
search field for "empty". The `Remember “<row>” ...` box is inside the section. With the
search box empty and the wizard's "Shows as:" gone, the Team name input is the only
full-name node under its caption; `New Team: <row>` (raw name, never the draft) proves
the walk did not move.

Related: [[patterns_draft_echo_is_not_a_read_back]], [[neo255-one-marketplace-surfaces]].
