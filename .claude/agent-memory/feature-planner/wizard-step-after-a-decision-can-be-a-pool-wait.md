---
name: wizard-step-after-a-decision-can-be-a-pool-wait
description: In the Tidy-up wizard a pending TEAM row is not presentable, so the step after a player decision may be "Looking up N more names…" with NO Back and NO skip; any readBackDecision / skipUntilRow placed there must settle `still looking up` (LOOKUPS) first. The Wikidata pool is one FIFO per deployment shared by all CI shards.
metadata:
  type: feedback
---

Any spec step that needs a *presented* wizard row (a `Skip … — not a team`
button, the footer's `Back to previous decision`) right after a player
decision must first settle the batch's lookups with the house idiom
`expect(wizard.getByText(/still looking up/)).toBeHidden({ timeout: LOOKUPS })`
(walkToPlayerRow and ~9 specs already do this). `readBackDecision`'s ENTRY
contract ("the walk moved to the next name step or a post-name step") has a
third outcome it does not cover: every remaining row is a pending team, the
body says "Looking up N more names…", the footer is Cancel + "wait or skip",
and neither Back exists (`isPresentable` in entity-review-nav.ts: a pending
row is presented only when it is a league).

**Why:** NEO-424 set-history spec, phase 3 (Peak Performance): desktop green
in 91 s, mobile red at 7 s. The three team lookups (recorded fixtures, 0.0 s
each) sat ~15 s in `wikidataPool` behind another shard's 200-name batch:
the pool is `maxParallelism: 5` per deployment (Wikidata's ceiling) and
FIFO across every shard's operator, ~10 items/s under E2E. Which specs
overlap differs per project's shard plan, so the same step is green on one
pass and red on the other. "Looks like timing" here is a missing
precondition, not a budget problem; never raise the 7 s.

**How to apply:** when planning or reviewing a wizard spec, find every
`skipUntilRow` / `readBackDecision` / heading assert that follows a player
decision and precedes the team steps; put the LOOKUPS settle before it (or
inside the walking helper, before each 7 s "a skip is on screen" assert).
Also after a sport switch, which re-queues that row's lookup. Reading the
decision off the Decided list instead of Back avoids only the Back half;
the team step still has to arrive. The FIFO-across-operators fairness is a
multi-operator product question, not something to change for a test.
