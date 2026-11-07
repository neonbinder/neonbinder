---
name: wizard-step-after-a-decision-can-be-a-pool-wait
description: In the Tidy-up wizard a pending TEAM row is not presentable, and a player step on screen is PRE-EMPTED the moment a team row settles (teams-first yield); so while "N still looking up" is up, a visible player step is transient. Any skipUntilRow / readBackDecision / step assert must settle `still looking up` (LOOKUPS) first, even straight after the wizard opens. The Wikidata pool is one FIFO per deployment shared by all CI shards.
metadata:
  type: feedback
---

Any spec step that needs a *presented* wizard row (a `Skip … — not a team`
button, the footer's `Back to previous decision`, a player step's primary)
must first settle the batch's lookups with the house idiom
`expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: LOOKUPS })`
(walkToPlayerRow and ~9 specs already do this). Two facets:

1. **After a player decision**, the next step may be "Looking up N more
   names…" with NO Back and NO skip: every remaining row is a pending team
   (`isPresentable` in entity-review-nav.ts presents a pending row only when
   it is a league). `readBackDecision`'s ENTRY contract does not cover it.
2. **Straight after the wizard opens, or any time the line is up**, a
   presented PLAYER step is not stable: `resolveNav`'s NEO-236 teams-first
   yield moves an implicitly-pinned player off screen the moment any team row
   settles (NEO-341's `interactionOpen` guards only an open chooser/search,
   not a plain button press). A `skipUntilRow` that returns because the
   player's skip is visible, while a sibling team's lookup is still pending,
   hands the caller a step that can be gone before the click.

**Why:** NEO-424 set-history spec. Phase 3: desktop green, mobile red at 7 s;
three recorded team lookups sat ~15 s in `wikidataPool` behind another
shard's 200-name batch (`maxParallelism: 5` per deployment, FIFO across
every shard's operator). Phase 6: the walk opened on the player (his row is
inserted `ready`), the spec's seven checks all passed inside 22 ms, the one
team row's recorded lookup landed ~60 ms after the wizard's first `getBatch`,
the walk yielded to "New Team: …", and the click at +1.3 s (after axe) found
no player group. Desktop and the previous mobile pass won that race by a pool
tick (~200 ms). "Looks like timing" here is a missing precondition, not a
budget problem; never raise the 7 s.

**How to apply:** when planning or reviewing a wizard spec, find every
`skipUntilRow` / `readBackDecision` / heading or button assert that follows
the wizard opening or a player decision and precedes the team steps; put the
LOOKUPS settle before it, or inside the walking helper: whenever the
`still looking up` line is visible, settle it BEFORE testing for the target
step (not only when no skip is visible). Also after a sport switch, which
re-queues that row's lookup. Reading the decision off the Decided list
instead of Back avoids only the Back half; the team step still has to
arrive. The teams-first yield itself is Jason's NEO-236 design and the
FIFO-across-operators fairness is a multi-operator product question; neither
is something to change for a test.
