---
name: pick-a-fixture-owned-name-by-name
description: A committing wizard flow that links "whichever row comes first" can write a name other flows read (an alias is a deployment-wide lookup); choose the row BY NAME from names only its fixture raises — prove ownership from enrichment-lookups.json + every archived CI log
metadata:
  type: feedback
---

**Rule:** a flow whose write is keyed on a NAME (a team alias, a created team,
a career stint) picks that name explicitly, from names only its own fixture
can raise. Never "whichever row the wizard presents first".

**Why:** NEO-335, CI run 38198207277. `checklist-wizard-link-team-saves-alias`
linked the first team step on its own sole-writer set and saved it as an alias
of its minted team. The first step was a STAGED CAREER TEAM ("Montreal
Royals", off Jackie Robinson's history), and the four read-only Big League
flows stage the same name off their own players. An alias is resolved by
every team lookup in the deployment, so for the ~70 s it was live their walk
changed under them. Owning the SET does not mean owning the NAMES on its
review: staged career teams and leagues come from players' histories, which
cross sets.

**How to apply:**
- Previews answer wizard lookups from the committed recording
  `apps/web/convex/adapters/__fixtures__/enrichment-lookups.json` (NEO-289).
  Grep its `careerTeams`/`undatedCareerTeams` for the name: the players
  listed are every recorded source of that step. A name staged by one
  player who is only on your fixture is owned.
- Confirm against history: grep every archived `maestro.log` for the name and
  count flows (`sed 's#.*/debug/##; s#/.*##' | sort | uniq -c`). Skip controls
  log their row name in `resource-id=Skip <name> — …`, so any flow that ever
  walked the step shows up.
- Walk to the chosen row with a read-then-skip loop whose TAP names the row
  it read (`id: "Skip <escaped heading name> . (not a team|this team has no
  league)"`), so a guard/tap race can never skip the row under test
  ([[guard-then-tap-toctou]], [[runtime-names-need-regex-escaping]]). Skips
  are scoped to the set's `selectorOptionId` (`entityReviewSkips`), so they
  leak nothing.
- Card clubs are the BSC `teamName` facet of the set (public search, see the
  coordinator's private endpoint notes); they reach a ONE-marketplace review
  only if the fetch waits for its team lookups (NEO-333), so check a run's
  `Skip <club> — not a team` lines before relying on one.

Related: [[neo284-team-alias-fixture]], [[per-worker-data-isolation]].
