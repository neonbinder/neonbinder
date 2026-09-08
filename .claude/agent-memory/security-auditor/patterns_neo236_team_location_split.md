---
name: patterns-neo236-team-location-split
description: NEO-236 splits teams.name into name+location; the durable traps are that `location` is BOTH a creation field and an enrichment marker (silently kills enrichment), splitTeamName returns the CALLER's spelling of the location, and a validator that throws on values the operator never authored
metadata:
  type: project
---

Audited branch `neo-236-team-location-name-split` on 2026-09-05. `teams.name`
becomes the nickname, `teams.location` the optional place part, and the dedup
key `nameNormalized` is derived from the COMPOSED full name via the one helper
`convex/lib/teamRow.ts` (`teamRowFields` / `findTeamByFullName`). Because
`normalizeTeamName` token-SORTS, splitting a row cannot change its key — that
is what makes the rollout incremental and it is asserted, not assumed.

## The three traps worth carrying forward

**1. A field can be a creation field and an "already enriched" marker at the
same time, and nothing errors.** `teamEnrichmentMarkers` (adapters/wikidata.ts)
gates `enrichTeam`: any marker present and the row is skipped with a log line
and no lookup. NEO-236 renamed `city`→`location` in that list while
simultaneously making `location` an INPUT to `teams.findOrCreate` (the
TeamPicker "+ Create" and MissingTeamFixer forms), to the commit prelude's
`createTeamFromOperatorInput`, and to `seedChunkInternal`. So a team created
WITH a Location is born carrying the marker, and the `enqueueEnrichment` that
fires two lines after the insert skips it — no colours, no yearsActive, no
wikidataId, no espnId, silently. Three docblocks and one test assert the
opposite ("no creation path writes one, so it stays a valid marker"), which is
why it survives review. **The rule the NEO-240 league twin already documents:
before adding a marker, grep every INSERT into that table for the field.**
`leagueId` and `lastUpdated` are excluded for exactly this reason.

**2. A "mechanical" split helper that returns the caller's spelling is a
rename.** `lib/teams/team-name.ts` `splitTeamName(fullName, location)` compares
case-INSENSITIVELY but returns `location` as passed, not the matching slice of
`fullName` (pinned by its own test: `("SAN DIEGO PADRES","san diego")` →
`{location:"san diego", name:"PADRES"}`). It is tried FIRST in both the
migration and `applyEnrichmentInternal`, ahead of the punctuation fallback that
DOES keep our spelling — so a case-only difference re-cases an NB-owned name
from ESPN. The dedup-key assertion cannot catch it because the normaliser
lowercases. One-line fix: return `full.slice(0, loc.length)`.

**3. A validator that throws takes the whole batch with it when the value came
from upstream, not from the operator.** `entityReviewQueue.normalizeTeamCreate`
refuses an empty or >120-char composed name — correct for a form field, wrong
where the value is a marketplace checklist string or a Wikidata P54 label. It
is reached by `prefilledTeamCreate` inside `decideAllRemaining` (the "create
all remaining" bulk mutation) and by `recordDecision`'s `createTeams` (the
wizard sends one entry per accepted career-team label). `entityReviewQueue`
row names are unbounded — `startBatch` inserts them verbatim and they originate
in `previewCardFields.team`/`teams`, plain `v.string()` — so one long upstream
string makes a whole decision unrecordable. Plain `Error`, so prod shows
"Server Error". Fail-soft instead: omit the `create` payload and let the
prelude report the name as unresolved (it already inserts nothing without one).

## Reference points that hold (do not re-derive)

* **No new public surface.** The only new exports are
  `splitTeamLocations.{listSportsForSplit,applyBatch,run}` and
  `teams.findByFullNameInternal` — all `internal*`. `publicFunctionAuth*.test.ts`
  correctly untouched.
* **The armed one-shot follows NEO-214 exactly.** `assertSplitArmed()` is the
  first statement of both the `internalAction` (before the ESPN fetches) and
  the batch `internalMutation` (before any read), asserted on dry runs too,
  `ConvexError` so the message survives prod redaction, `confirm: v.literal`
  plus a REQUIRED `dryRun` boolean. No `requireAdmin`, no `--identity`.
* **The migration cannot rename.** `skipped_key_mismatch` never touches a
  hand-written key; a `location` already present means done (idempotent); ESPN
  entries that normalise to one key with two locations are DELETED from the map
  rather than resolved; and the recomputed key is asserted equal before the
  patch, throwing inside the mutation so the batch rolls back. The only escape
  is trap 2 above.
* **`findOrCreateInternal` is gone and that is the ticket's core win.** Every
  automated path — checklist commit `resolveTeamIdByName`, BSC
  `applyBscTeamResolution`, `backfillTeamToOnCardIds`, Wikidata P54 in
  `enrichPlayer` — now LOOKS UP and links, never inserts. `findOrCreate`
  (requireAdmin) and `seedChunkInternal` (hand-split dataset) are the only
  inserts left.
* **`saveTeamFields` still has no length cap** while `findOrCreate`,
  `nearMatches` and `entityReviewQueue` all refuse >120 on the composed name,
  and the client inputs carry no `maxLength`. Same shape as the NEO-240
  `leagues.create` gap — see [[patterns-neo240-league-management]].
* **`applyBscTeamResolution` on a miss stamps `teamCheckDoneAt` and keeps
  nothing.** Contrast `backfillTeamToOnCardIds`, which deliberately keeps
  `row.team` as "the only record of what the marketplace claimed". The obvious
  fix is wrong: writing `pendingTeamNames` SUPPRESSES the `missingTeam` badge
  (`features/cardAttention.ts` treats it as having a team) — see
  [[patterns-neo220-review-session-safety]].
* **Search index `name` → `nameNormalized` exposes nothing new** — it is
  derived from fields already on every returned doc, and the auth on `search` /
  `nearMatches` / `resolveNames` is unchanged. The query side must use the
  UNSORTED token join (`nameTokens`), not the sorted normaliser, because Convex
  prefix-matches only the final term.
* **`unresolvedTeamNames` never reaches a public surface**: returned by an
  `internalMutation` to an admin-gated action that logs the COUNT only.

See [[patterns-neo219-sanctioned-delete]] for the armed-script shape this
copies and [[patterns-convex-auth-boundary]] for the registry rule.

## Delta audit — the New Team steps commit (a807220), 2026-09-05

A player's career teams became their OWN review rows
(`entityReviewQueue.stageCareerTeamRows` + `stageCareerTeamRowsImpl`),
walked ahead of the player and answered on a New Team step that also asks
the League. Three durable lessons, all of them about the SECOND half of a
validated value's journey.

**4. A value validated on ONE write path is unvalidated on the other, and
the second path is the one with no operator in front of it.** NEO-236 added
`leagues.resolveOperatorLeagueId`, which refuses a league that no longer
exists and one belonging to another sport. `teams.findOrCreate` routes
through it. The review-queue twin does not: `normalizeLeagueChoice`
(entityReviewQueue.ts:275) passes `leagueId` "through untouched" and
`reviewedTeamFields` (selectorOptions.ts:9373) writes it onto the new
`teams` row as `leagueId = create.leagueId ?? undefined`. So a decision
recorded through `recordDecision` can file a team under another sport's
league, or under a deleted id. The tell that this is a real gap and not a
judgement call is INSIDE the same function: `recordDecision`'s `link`
branch already sport-validates `linkedTeamId`/`linkedPlayerId`
(entityReviewQueue.ts:1187, 1205) with the comment "defense in depth: this
is admin-gated, but still validate the shape so a malformed year can never
reach the players.teamYears write in commitCardChecklist". `create.leagueId`
reaches a `teams.leagueId` write and gets neither check.
**The rule: when a ticket adds a resolver whose whole job is refusing bad
input, grep every OTHER writer of that same field before calling it done.**

**5. A cap on `added.length` inside one invocation is not a cap on the
table.** `stageCareerTeamRowsImpl` breaks at 64 (entityReviewQueue.ts:827)
and its comment claims "the same bound the per-decision create list
carried" — but `normalizeCareerTeamCreates` THROWS on a list over 64, while
this one silently truncates PER CALL, and the mutation is documented as
"the client may call it as often as it likes". N calls with distinct names
grow the batch and enqueue N×64 pooled Wikidata lookups. Same shape as the
`saveTeamFields` length gap: idempotent-by-key is not the same as bounded.

**6. A new INDEXED field is a new place for an unbounded string to land.**
`stageCareerTeamRows` takes `careerTeamNames: v.array(v.string())` and
`stageCareerTeamRowsImpl` trims but never measures, inserting into both
`name` and the indexed `nameNormalized`. Every other operator team-name
entry point refuses >120 (`teams.findOrCreate`, `requireTeamCreate`), so
the result is a row that can never be DECIDED — trap 3 above, reached from
a new direction. Fail-soft fix (`continue`, not throw) matches what
`normalizeCareerTeamCreates` already does for over-long upstream labels.

Also worth carrying: an exemption from reconciliation creates orphans.
`row.source === undefined` (entityReviewQueue.ts:648) keeps staged rows out
of the undecided-drop, correctly — but if the PLAYER row is dropped, its
staged team rows survive with a dangling `source.playerRowId`, `walkOrder`
(:951) falls them back to their own position, and answering one mints a
`teams` (and possibly a `leagues`) row for a player nothing is reviewing.
An exemption needs its own drop rule, not just an exclusion.

### Reference points that hold in the delta (do not re-derive)

* **The public gate is right and pinned.** `stageCareerTeamRows` =
  `requireAdmin` + `assertOwnsRow`, added to `publicFunctionAuth.test.ts`
  in the same commit. Staged rows are stamped `playerRow.createdByUserId`
  and inserted into the player's own `selectorOptionId`/`batchId`/`sportId`
  — no cross-user or cross-batch write is reachable, and batchId is per
  (selectorOptionId, createdByUserId) so the new
  `by_batch_and_kind_and_name` index is user-scoped by construction.
* **No recursion.** `kind !== "player"` returns early (:799) AND both call
  sites guard (:1389, :1700). A staged team row's own lookup stages nothing.
* **`source.playerRowId` is presentation-only** — `walkOrder` and the
  wizard's "Needed by". A stale one degrades ordering, never a write.
* **No `collect` in the staging path** — one narrow indexed range per
  proposal, which is what NEO-189 requires of a pool-driven mutation.
* **Cross-sport team creation is genuinely closed**, just not via the
  staged decision: `createTeamFromOperatorInput` always inserts with the
  COMMIT's `args.sportId`, and `reviewedTeamFields`' `findOrCreateLeague`
  is scoped to it too. Only the `leagueId` passthrough escapes.
* **`careerTeamCreateValidator` does not accept league fields** (:119), so
  the legacy `createTeams` path cannot smuggle a league id in.
* **`lookupTeamEnrichment(name, sport, knownQid)` is safe** —
  `isWikidataQid` (`^Q\d+$`, anchored, no `g` flag) gates the value before
  SPARQL interpolation, and an invalid one falls back to the name search
  rather than throwing. The NEO-212 chokepoint module paid off again.
* **Client surface is clean**: no new `console.*` anywhere in the delta, no
  `dangerouslySetInnerHTML`, new interpolations are only `aria-label` text
  (React sets those as properties), new `href`s go through
  `wikidataUrl`/`wikipediaUrl`. `NewTeamDialog` traps Tab, `stopPropagation`s
  Escape so it cannot also defer the walker's card, and restores focus to
  the opener; `newTeamOpenRef` is cleared on both exits. Its one soft spot
  is that Escape, the scrim and Cancel are ALL closed while `creating` — a
  Convex mutation pending across a reconnect leaves no way out.
* **Schema is additive**: every new field is `v.optional`, old rows
  validate. The new index's optional `nameNormalized` makes a legacy row
  invisible to key-dedup — documented, and `findTeamByFullName` still
  catches it.
