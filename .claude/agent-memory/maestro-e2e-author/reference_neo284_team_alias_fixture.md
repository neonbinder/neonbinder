---
name: neo284-team-alias-fixture
description: NEO-284 team-alias E2E — since NEO-330 the one-sided 1996 Line Up Venezuelan Winter League fixture (300 cards, 8 unknown clubs, one club acted on BY NAME), how the "remember as alias" checkbox is asserted without a `checked` attribute, the decision read-back via "Back to previous decision", the wizard's TWO "Cancel (Esc)" texts, the NEO-326 empty "Search all teams" + body pin, and the wrong-SportLots-slot recovery via the MultiSourcePanel chip
metadata:
  type: reference
---

# NEO-284 — `checklist-wizard-link-team-saves-alias` facts (2026-09-16)

**Fixture (NEO-330):** Baseball → 1996 → All Brands → *Line Up Venezuelan
Winter League* → Base, BSC only, via
`util-fetch-one-marketplace-set-checklist-to-wizard`. 200 players + 8 clubs
unknown; 211 rows settle (a staged league + 2 staged career teams) after
~144 s of LIVE lookups; all 211 are now in the NEO-289 recording, so the
settle time must be re-measured from CI (see
[[record-a-fixture-sets-lookups]]). The walk reads every team/league heading and acts on
one checklist club BY NAME (Navegantes → alias link), skipping the rest —
`runFlow when: true: ${heading === …}` branches are free. The past-era claims
(Tigres → the catalogue's single `Pittsburgh Crawfords`) moved out in NEO-330
to `checklist-wizard-past-era-team-link-commits`, see [[past-era-team-fixture]]. The alias-clash holder (`Pca`) now
lives on the minted `Loc Ali` team. Until NEO-330 it was the 4-card Rickwood
Field set, whose clubs the reference catalogue now holds.

**It is ONE-SIDED — cancel the base picker.** (Rickwood history:) SportLots did not carry the
set; the picker's SL column is the year's whole catalogue with "Base Set"
flagged "likely match" (= 2024 Topps flagship, 352 cards). Taking the
first-candidate path (`util-drill-to-base-variant`) attaches that wrong set
and pairs 0 of 4. Cancel → "Base mapping cancelled" → Close → "Map Base Set"
→ Sync → the NEO-255 solo path ("Kept all N cards from BSC"), no Match Cards
dialog, so `util-fetch-real-set-checklist-to-wizard` cannot be used
(hand-roll it like `checklist-one-marketplace-skips-match-dialog`).

**Recovering from a wrong SportLots slot on a preview:** the
`MultiSourcePanel` chip — `Remove <label>` then `Confirm detach <label>` —
takes the slot off; the picker auto-reopens (unmapped again) and the set is
back to the fresh-sync shape. No reseed needed.

**Asserting the checkbox is ON:** maestro-web's hierarchy has NO `checked`
attribute (pinned maestro-web.js: `text` = value||placeholder||ariaLabel, and
a checkbox's `value` is "on" either way). Assert the effect instead: the
decision line `Linked to <team> · remembered as “<row>”` is composed by
`describeDecision` ONLY when `decision.saveAsAlias` is true on a team link.
Read it back by tapping `id: "Back to previous decision"` after the link
(the wizard walks on immediately) → `id: "Decision for <row name>"` group →
the text; then `Next` (anchored `below: "Already decided:.*"`) resumes.

**The linked row is named, and the skip tap names the row it read.** The
alias is live deployment-wide between commit and cleanup, so the linked
string must be one no other flow can look up: "whichever club comes first"
once linked "Montreal Royals", a career team the Big League flows also stage,
and changed their walks (see [[pick-a-fixture-owned-name-by-name]]). On the
Venezuelan set that is Navegantes, a BSC card club no other flow's set
carries. The walk's skip tap is built from the heading it just copied
(`Skip <escaped name> . (not a team|this team has no league)`, optional): a
bare `Skip .*` tap issued while the previous skip lands can hit the NEXT row,
which may be the row under test (NEO-335; [[guard-then-tap-toctou]]).

**The Base-mapping notice's Close straddles the fold** after the warm drill
(local y=603-635 on 625; CI's 15px horizontal scrollbar → 618-650 on 629 →
the tap dies `null cannot be cast to non-null type kotlin.Int`). Centre it
(`scrollUntilVisible "Close" centerElement`, ~2s) before tapping.

**A hand-staged career team's "New Team:" step waits on the deployment-wide
Wikidata pool** (`maxParallelism: 5`, FIFO across every runner): with two Big
League batches (88 rows each) just queued by other runners, the staged row
stayed "1 still being looked up" past 30s. Gate on `.*still looking up.*`
going away (180000, the external exception) between a 7000 "stage landed"
wait and the 7000 step wait — `checklist-wizard-career-team-commits`.

**Two "Cancel (Esc)" texts while the link search is open:** the search panel
has its own (`id: "Cancel linking"`), and `tapOn: text: "Cancel (Esc)"` hits
it first, closing only the panel. Exit through the footer once the panel is
closed, or target `id`.

**The wizard's counter counts EVERY decision** — "Step x of y" since
NEO-335, x = decided + 1 on a name step — so never pin x after the link;
wait for the row's heading to go (`notVisible: "New Team: <row>"`) instead.

**Team Management after the commit:** filter by the single token, open the
row by its printed short name `below:` the counter, then `scrollUntilVisible
"Also known as"` (centres in ~2s with the spacer). The alias is on screen
twice — the textarea VALUE and the chip — and `id: "Current aliases"` (the
`<ul>`) is the chip list's presence. Empty textarea = its placeholder text
("LSU, Louisiana State, LSU Tigers baseball") is the positive for "gone".

**NEO-326 team-step shape (2026-10-04):** `Search all teams` sits in an
ALWAYS-ON bordered section headed `Link to existing team` (players/leagues
keep "Possible matches") and starts EMPTY, so it reads back its placeholder
`Type a team name` — assert `{id: "Search all teams", text: "Type a team
name"}` for "empty". The `Remember “<row>” …` box is inside the section,
`below: {id: "Search all teams"}`. The box's chrome (~60px) pushes the New
Team form's Team name box under the footer on a body at its top, so the flow
pins the body with one UP touch drag before tapping it and one long DOWN drag
back to the top before the search (see [[touch-swipe-scrolls-a-dialog-body]]).
With the search box empty and the wizard's "Shows as:" gone, the Team name
input is the only full-name node under its caption; "New Team: <row>" (raw
name, never the draft) proves the walk did not move.

Related: [[maestro-web-getnodetext-form-values]], [[erase-text-needs-the-caret-at-the-end]],
[[neo255-one-marketplace-surfaces]].
