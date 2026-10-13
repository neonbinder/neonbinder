---
name: pick-a-fixture-owned-name-by-name
description: A committing wizard spec that links "whichever row comes first" can write a name other specs read (an alias is a deployment-wide lookup); choose the row BY NAME from names only its fixture raises, and prove ownership from enrichment-lookups.json plus every archived CI log
metadata:
  type: feedback
---

**Rule:** a spec whose write is keyed on a NAME (a team alias, a created team, a
career stint) picks that name explicitly, from names only its own fixture can
raise. Never "whichever row the wizard presents first".

**Why:** NEO-335, a CI run. The alias-saving spec linked the first team step on its
own sole-writer set and saved it as an alias of its minted team. The first step
was a STAGED CAREER TEAM (off a player's history), and the four read-only Big
League specs stage the same name off their own players. An alias is resolved by
every team lookup in the deployment, so while it was live their walk changed under
them. Owning the SET does not mean owning the NAMES on its review: staged career
teams and leagues come from players' histories, which cross sets.

**How to apply:**
- Previews answer wizard lookups from the committed recording
  `apps/web/convex/adapters/__fixtures__/enrichment-lookups.json` (NEO-289). Grep
  its `careerTeams`/`undatedCareerTeams` for the name: the players listed are every
  recorded source of that step. A name staged by one player who is only on your
  fixture is owned.
- Confirm against history: search every archived run log for the name and count the
  specs that touched it. A skip control's accessible name carries its row name
  (`Skip <name> ...`), so any spec that ever walked the step shows up.
- Walk to the chosen row with a read-then-skip loop whose click NAMES the row it
  read (`Skip <escaped heading name> . (not a team|this team has no league)`), so
  a guard/click race can never skip the row under test
  ([[runtime-names-need-regex-escaping]]). Skips are scoped to the set's
  `selectorOptionId` (`entityReviewSkips`), so they leak nothing.
- Card clubs are the BSC `teamName` facet of the set; they reach a ONE-marketplace
  review only if the fetch waits for its team lookups (NEO-333), so check a run's
  `Skip <club> (not a team)` steps before relying on one.

Related: [[neo284-team-alias-fixture]], [[per-worker-data-isolation]].
