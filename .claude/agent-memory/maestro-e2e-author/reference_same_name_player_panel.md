---
name: same-name-player-panel
description: NEO-254 "Same name, different people" wizard panel — the bulk never decides these rows, so any wizard drain must answer them; selectors and why to tap the TOP candidate only
metadata:
  type: reference
---

`SameNamePlayerPanel` renders on a player row when 2+ NB players share the
normalized name. The footer bulk (`Add remaining players as new`) SKIPS these
rows on purpose (live `players.isAmbiguousPlayerName`), so they stay undecided
and `Confirm & Save` never renders until each is answered by hand.

Selectors (all user-visible):
- heading text node, full match: `Same name, different people`
- list: `id: "Players already filed under this name"`
- each candidate: `id: "Link to <name>, [On a roster that year, ]b. YYYY · <career>"`
  (ordinal `option N of M` when nothing is on file). One tap = a link decision;
  the walk then advances to the next undecided row.
- The footer's `Link to existing instead` also matches `Link to .*` — scope with
  `childOf: {id: "Players already filed under this name"}`.

Tap `index: 0` (top). Candidates are sorted by birth year, not by the
roster-year flag, and the panel sits right under the row name, so rows 5+ can
fall under the dialog footer where a tap hits a footer button
([[inner-scroller-clip-is-invisible-to-maestro]], [[guard-a-tap-at-a-footer-buttons-x]]).

Why it matters: a deployment pre-loaded with a player catalogue (NEO-330) turns
a ~300-name "all new" batch into a handful of rows, several of them same-name.
A drain loop that only knows `Add as New (Team|League)` + `Confirm & Save`
parks on such a row until its wait times out. Related: [[wizard-drain-loop-one-footer-guard]].
