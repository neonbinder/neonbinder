---
name: patterns-neo253-entity-name-fold
description: NEO-253 collapsed six hand-copied entity-name normalisers into lib/entities/normalize-name.ts and added an NFD diacritics fold; the durable audit rules are where the fold/no-fold read-write pairs still sit, which rename path lacks a collision guard, and that a convex-test file calling findOrCreate or startBatch MUST drain scheduled work
metadata:
  type: project
---

Audited 2026-09-06 at `e2c67c99` (branch `neo-253-fold-diacritics`, apps/web).

**The shape.** `apps/web/lib/entities/normalize-name.ts` is now the ONE chain:
`foldDiacritics` (NFD + strip `[̀-ͯ]`) → `toLowerCase` → drop
`` [.,'"`’] `` → `[^a-z0-9\s-]` → space → split/filter → `entityNameTokens`
(source order) / `normalizeEntityName` (sorted, players+teams) /
`normalizeOrderedEntityName` (unsorted, leagues). It lives in `lib/` not
`convex/` because the browser review wizard needs the same key — same shelf as
`lib/players/name-limits.ts`. `normalizePlayerName` / `normalizeTeamName` /
`normalizeLeagueName` / `selectorOptions`'s `normalizeName` and the prelude's
`norm` / `entityNearMatch`'s `normalizeEntityName`+`nameTokens` are all aliases
or re-exports of it now. `lib/cards/card-name.ts` `nameKey`,
`convex/adapters/teamColorCodes.ts` `colorSourceMatchKey` and
`lib/teams/seed-team-lookup.ts` `seedMatchKey` share the FOLD only.

**Why the fold is safe to insert without a backfill:** NFD is the identity on
ASCII, so every existing unaccented key is byte-identical. Accented stored keys
ARE stale and unreachable; Jason accepted that (2026-09-04, "wipe and reload"),
and it is written down on `players.nameNormalized` in `schema.ts` and in the
module note. **If production ever holds real entity data, this decision has to
be revisited before any further change to that chain.**

**The audit question for this whole family is always the same: does BOTH sides
of a comparison run through the same function?** Confirmed symmetric at
`players`/`teams`/`leagues` find+insert+rename, `cardChecklist.ts` team
resolution, `seedTeamColors.ts`, `entityReviewSkips` (prelude writes with
`norm`, `findSkippedEntityNames` reads with `normalizePlayerName`/`TeamName`),
`entityReviewQueue.startBatch`'s resume key, the excluded-career-team set, both
`colorSourceMatchKey` call sites, and `findSeedColors`'s runtime-built index.

Still unfolded on one side — check these first on any follow-up:

1. `saveTeamFields` (`convex/teams.ts` ~566) rewrites `nameNormalized` with **no
   NAME_TAKEN collision guard**, unlike `savePlayerFields` (`players.ts` ~1021)
   and `saveLeagueFields` (`leagues.ts` ~915). Folding widened what collides, so
   an accent-only rename can now write a duplicate `(nameNormalized, sportId)`
   that `findByNameAndSport`'s `.first()` resolves non-deterministically.
2. `PlayerPicker.tsx` / `TeamPicker.tsx` `hasExactMatch` is a plain
   `toLowerCase()` equality and the candidate filter is a raw substring, while
   the `findOrCreate` they call folds. The picker offers "+ Create" and the
   server links instead — the "wizard says 3, commit creates 2" shape.
3. The prelude's skipped/resolved name sets (`selectorOptions.ts` ~10633 and the
   NEO-221 merge ~10155) are **exact trimmed strings**, matched against
   `pendingPlayerNames`. Folding collapses two spellings into one review row, so
   the other spelling's literal never lands in the settled set and stays pending.
4. `players.nearMatches`: the exact leg folds, but the fallback search term is
   folded while the `search_name` index is over the raw `name`.
5. `convex/lib/pairing/names.ts` deliberately does NOT fold (verbatim port of
   `services/preprocess/app/pairing/names.py`). Do not "fix" it.

**Test rule that this ticket re-proved (NEO-220):** a `convex-test` file that
calls `api.players.findOrCreate` (schedules `wikidataPool.enqueueEnrichment` on
the insert branch) or `internal.entityReviewQueue.startBatch` (schedules
`enqueueEntityReviewLookups`) leaves `runAfter(0)` work racing worker teardown —
green tests, **failed job**, CI-only, timing-dependent. Every such file must
`await drainScheduled(t)` from `lib/testing/drain-scheduled.ts`. This is worth
grepping for in every audit round, because a local run never shows it.
`commitCardChecklist` only schedules when it CREATED teams or has BSC enrichment
ids, so a players-only fixture there is clean.
