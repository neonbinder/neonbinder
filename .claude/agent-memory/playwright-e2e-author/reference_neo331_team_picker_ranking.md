---
name: neo331-team-picker-ranking
description: NEO-331 — TeamPicker orders candidates by the set's League feature + year (4 tiers); how team-picker-ranks-by-set-context proves it with zero card writes; league level now required everywhere (pills unselected, primaries held); no sport default (pick MLB explicitly — the seed owns the row); the held-rows "No matches." trap
metadata:
  type: reference
---

Written 2026-10-10 from the code, before the first preview run. Re-check the
components before trusting any of it.

**Ranking.** `teams.pickerCandidates` reads `features.league` off the picker's
`contextOptionId` row (the checklist's variant row in quick-add, drawer and
walker; the set row on the set-level Team row) and the nearest `year`
ancestor. Tiers: 1 set league + active in Y; 2 league level `minor` + active;
3 set league, not active (closed or UNDATED); 4 the rest. Within a tier: prefix
match, then A–Z. Player Management passes no context (name order).

**Proof pattern (team-picker-ranks-by-set-context.yaml).** Four teams whose
A–Z order is the reverse of tier order, sharing one prefix that ENDS IN A
LETTER (`TPR<token>Q`) so a longer token from another attempt cannot
prefix-match and interleave. Gate each round on the LAST-created team's option
(any search window containing the newest row contains all four, so the order
is tier-fixed even while TeamPicker shows held rows), assert order with
`below:` on the era-qualified option ids (`Add <name> . 1958.present`), then
`pressKey: Enter` takes row 0 and the chip names the head. Everything runs in
the quick-add form's picker (chips are local state) and the form is cancelled:
no card is written. Tap the search box before each `inputText` so the pointer
never rests on an option (onMouseEnter moves the highlight).

**League level is required (Jason: "force a choice").** `LevelGroup` is now a
radiogroup of six pills (visible text Major/Minor/College/International/
Independent/Other, no aria-label), nothing checked; `Add as New League`, the
picker form's `Add league` and League Management's `Create league …` are
`aria-disabled` until one is pressed (a press only focuses the group). Tap by
text: `tapOn: "Minor"`. Drains use `set-selector/util-wizard-answer-step-as-new.yaml`
([[branch-on-copied-button-text]]).

**Trap 1 — no sport default; "MLB" by abbreviation.** Since ae04f64 an
unanswered League leaves a team league-less (dialog, wizard commit, bulk
load), so a flow that wants MLB PICKS it: `id: "League"` → type
`Major League Baseb` → tap `Major League Baseball` → read back
`id: League, text: Major League Baseball`. The row is the SEED's: on a
reference-catalogue preview (NEO-330) the catalogue imports it (level Major,
abbr MLB, aliases AL/NL/American League/National League; still the only MLB
league); on a plain reset setup's Base wizard drain stages a New League step
from the committed enrichment recording (P118 label, abbreviation "MLB"),
presses Other, Confirm & Save writes it (`enrichLeague` in convex-logs right
after Confirm & Save). No alias "MLB", so
`pickerContext` reaches it via the unique-abbreviation fallback (10c466b); a
second league abbreviated MLB makes the fallback return nothing. Symptom of a
miss: ranking round 1 reads Y, W, X, Z (tiers 1/3 empty).

**Trap 2 — held rows.** TeamPicker keeps the previous answer on screen while
a new query loads (no "Loading…" flash). Since 10c466b held rows render an
aria-hidden spacer, never `No matches.`, so that line now means "the CURRENT
answer is empty". A row on screen that does not contain the typed text is the
current answer, not held rows (held rows are name-filtered).

**Trap 3 — measured on the first CI run (2026-10-10).** (a) The server's
search legs are BM25 any-term: "Pittsburgh Crawfords" returns Pittsburgh
Pirates, and once the client stopped name-filtering current answers (to admit
alias hits) the row showed and `No matches.` never came — and tier sorts
before prefix, so a tier-1 partial match beats the exact row for Enter.
(b) A missing row that every fresh probe returns = the stale same-text search
read set ([[convex-same-text-search-legs-go-stale]]), not held rows. Both are
product findings; the ranking flow and link-team-saves-alias flow were right.
