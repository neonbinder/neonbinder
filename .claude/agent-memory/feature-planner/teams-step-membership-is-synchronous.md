---
name: teams-step-membership-is-synchronous
description: Who is on the entity-review Teams step ("Cards with no team") is decided from review rows + fetch-time preview facts + stored people, never from teamSuggestionsForPreview evidence; the step counter's high-water marks cannot shrink
metadata:
  type: project
---
Any rule that changes WHICH cards sit on the wizard's Teams step must be
expressible from inputs the wizard has before evidence loads: the review rows
(`getBatch`, each with `sportId`), the preview's server facts
(`resolveChecklistEntities` output → `FetchPreview` fields such as
`settledTeamIndexes`, `playerlessIndexes`, skip records) and the host's
`StoredPeople`. Server evidence (`teamSuggestionsForPreview`) only decides
pre-fill and choices, and is fetched only after every name is decided.

**Why:** `entity-review-steps.ts` counts the Teams step optimistically with
`cardsForTeamsStep` before evidence exists, and `advanceStepCount` is a
high-water mark (y never shrinks; growth is announced). A membership rule that
waits on evidence either over-counts y or makes lines vanish after they were
shown. The host also uses `teamlessCardIndexes` to decide whether to open the
wizard at all on the no-names path (`askTeams`), where no evidence exists.

**How to apply:** when planning "cards of kind X skip the Teams step", add the
fact as a `StoredPeople` member or a preview field produced server-side at
fetch (the gate already resolves every printed name, so per-name facts are
cheap there), and make the server commit the authority for what is stamped.
