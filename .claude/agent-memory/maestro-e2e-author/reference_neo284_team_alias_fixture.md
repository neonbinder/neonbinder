---
name: neo284-team-alias-fixture
description: NEO-284 team-alias E2E — the one-sided Rickwood fixture (4 BSC cards, Negro League clubs, SportLots picker CANCELLED), how the "remember as alias" checkbox is asserted without a `checked` attribute, the decision read-back via "Back to previous decision", the wizard's TWO "Cancel (Esc)" texts, and the wrong-SportLots-slot recovery via the MultiSourcePanel chip
metadata:
  type: reference
---

# NEO-284 — `checklist-wizard-link-team-saves-alias` facts (2026-09-16)

**Fixture:** Baseball → 2024 → Topps → *Topps MLB at Rickwood Field Negro
Leagues Collection* → Base. BSC: 4 cards (Paige, Gibson, Robinson, Mays) on
Negro League clubs; 8 unknown names = 4 players + clubs + ONE staged league
("Negro league baseball", presented FIRST — skip it with `Skip .* has no
league`, then the first team row follows). It is the smallest 2024 Topps set
whose wizard opens on a TEAM row (team sets of MLB clubs have 0 unknown teams
because the Chrome seed commit creates all 30).

**It is ONE-SIDED — cancel the base picker.** SportLots does not carry the
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

**The row's raw name is read off its heading** with `copyTextFrom: text:
"New Team: .*"` + `evalScript` strip — the alias claim is "the checklist's
spelling, exactly", so no club name is hard-coded.

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

**The wizard's counter counts EVERY decision** — after a league skip + a team
link it reads "2 of N", so never wait for "1 of N" after the link; wait for
the row's heading to go (`notVisible: "New Team: <row>"`) instead.

**Team Management after the commit:** filter by the single token, open the
row by its printed short name `below:` the counter, then `scrollUntilVisible
"Also known as"` (centres in ~2s with the spacer). The alias is on screen
twice — the textarea VALUE and the chip — and `id: "Current aliases"` (the
`<ul>`) is the chip list's presence. Empty textarea = its placeholder text
("LSU, Louisiana State, LSU Tigers baseball") is the positive for "gone".

Related: [[maestro-web-getnodetext-form-values]], [[erase-text-needs-the-caret-at-the-end]],
[[neo255-one-marketplace-surfaces]].
