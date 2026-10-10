---
name: reference-catalogue-on-ci-previews
description: "NEO-330: CI previews start each run holding prod's reference catalogue (~113k players, ~10.5k teams, leagues, franchises, aliases). How to check a fixture name against the bundle, the spelling trap it exposed, and the capped client-side lists that cannot show a row minted mid-run"
metadata:
  type: reference
---

Since NEO-330, every CI E2E run loads prod's reference catalogue onto the PR
preview right after the reset and before setup.yaml. The README's Companion rules
cover the rules ("A reference catalogue is on every CI preview…"). These are the
working facts behind them.

**Check names against the bundle, not by guessing.** The bundle is a
`convex export`-shaped zip (`<table>/documents.jsonl` plus `manifest.json` with
per-table and per-sport counts). Unzip it into a scratch dir and run
`grep '"name":"…"' players/documents.jsonl`. Use python `-I` to
tokenise `nameNormalized` when you need "does any word start with X" (that is
what `players.search` prefix-matches on the last term). The ops runbook
(docs/operations/neo330-reference-seed.md) says where the bundle lives. Never
copy rows out of it into a flow comment or memory beyond a name you assert.

**Catalogue spellings are not marketplace spellings.** Bulk-loaded players use
the Lahman shape: spaced initials (`J. T. Realmuto`). A seed commit of the
BSC spelling (`J.T. Realmuto`) keys the same (NEO-322 joins initials), so it
ADOPTS the catalogue row and no unspaced row ever exists.
`player-add-spaced-initials-opens-roster-row` had to flip direction: it now
types `J.T.` at the spaced row. Any flow asserting a real person's exact
spelling should be checked against the bundle.

**Capped lists that read in insertion order hide everything minted mid-run.**
A `.take(N)` with no index walks `_creationTime` ascending, so the catalogue
fills the window and a row a flow just made sits past it:
- `teams.listForManagement` (2000) drives /admin/teams. Its filter is
  CLIENT-side over that window, so a minted team never appears, and
  `?team=<id>` is ignored for an id outside it. This breaks every flow that
  filters Team Management to its own team. It is a product fix; no flow
  workaround exists.
- `teams.listForPicker` (2000) is the spine-label free-form team picker:
  same shape, but no flow drives it with a minted team.
- These are SAFE because a typed query goes to a search index:
  `players.listForManagement` (500, the page switches to `players.search` past
  two characters), PlayerPicker (a 500-row pool topped up by `players.search`),
  TeamPicker, CareerTeamEntry and EntityLinkSearch (`teams.search` /
  `players.search`). `franchises.list` reads newest-first (NEO-254).
- Before trusting any admin list at scale, read the query: is the filter
  server-side, and which end of the table does the cap keep?

**Free text is unaffected.** A card's name (the quick-add "Player name"
placeholder is the CARD NAME box), the spine label's "Name on the label", and
descriptions never reach a search. Multi-word card names were still made
single tokens for the rule's sake.

See [[real-person-fixture-names-collide-with-committed-checklists]],
[[exact-match-proof-is-the-demoted-create]],
[[probe-a-fixture-without-draining-it]].
