---
name: reference-neo92-entity-review-wizard-test-suite
description: Test file layout + mocking conventions for NEO-92's entityReviewQueue/EntityReviewWizard (replaces the old UnknownEntitiesDialog); requireAdmin gate on entityReviewQueue.ts's public functions; commitCardChecklist's confirmedNewPlayers/confirmedNewTeams -> batchId migration fix pattern.
metadata:
  type: reference
---

## File layout added

- `convex/entityReviewQueue.ts` (source, root-level) — `startBatch`
  (internalMutation), `getBatch`/`recordDecision`/`cancelBatch` (PUBLIC,
  `requireAdmin`-gated), `getInternal`/`applyLookupResult`/`cleanupBatch`
  (internal, no auth check).
- `convex/entityReviewQueue.test.ts` — CRUD tests, lives at root (source
  already at root, no module-glob issue).
- `convex/wikidataEntityReviewQueue.test.ts` — `lookupPlayerEnrichment`/
  `lookupTeamEnrichment` (pure functions, importable directly, no
  convex-test needed) + `processEntityReviewQueue` (internalAction, needs
  real convex-test action/scheduler harness — lives at convex/ ROOT per
  [[reference-convextest-modules-glob-must-be-convex-root]] since the
  source is under `convex/adapters/`).
- `convex/commitCardChecklist.entityReview.test.ts` — integration tests for
  `commitCardChecklist`'s decision-driven create/link resolution.
- `components/SetSelector/EntityReviewWizard.test.tsx` /
  `EntityLinkSearch.test.tsx` — component tests, identity-routed
  `useQuery`/`useMutation` mocks per the established pattern in
  [[reference-reactive-field-editing-in-tests]].

## requireAdmin gate — CONFIRM before assuming getCurrentUserId

`entityReviewQueue.ts`'s public functions (`getBatch`, `recordDecision`,
`cancelBatch`) are gated with `requireAdmin(ctx)` (throws unless
`role === "admin"` in the identity), NOT the bare `getCurrentUserId(ctx)`
check its own docstring/an earlier draft implied. Tests must use
`t.withIdentity({ ..., role: "admin" })`, not just any authenticated
identity — a non-admin identity gets "Admin access required", a
different error than the unauthenticated case. `recordDecision`'s "link"
branch ALSO validates the linked player/team actually exists AND its
sport matches the reviewed row's sport, throwing otherwise — this wasn't
in an earlier version of the file either.

**This file visibly changed mid-session** (from `getCurrentUserId` to
`requireAdmin`, `recordDecision` gaining the sport-match validation) while
another agent (plan implementation / security-auditor) was iterating on
the same in-flight branch concurrently. Lesson: in an actively-worked
worktree, re-`Read` any dependency file immediately before writing tests
against it — don't trust an earlier read in the same conversation. Run
the full suite (`npx vitest run`) again after finishing to catch drift
that happened mid-session.

## commitCardChecklist migration pattern: confirmedNewPlayers/confirmedNewTeams -> batchId

When `commitCardChecklist`'s args changed from `confirmedNewPlayers/
confirmedNewTeams: string[]` to `batchId?: string`, existing tests broke
not because of decision logic but because the OLD args used to
auto-create players/teams as a side effect. Fix per test, in order of
preference:
1. If the test doesn't assert anything about the player/team's identity
   (just card features, SKU format, totalCardCount, etc.) — just delete
   the old args, no replacement needed.
2. If the test asserts something that depends on a REAL resolved
   `playerIds`/`teamOnCardIds` (e.g. `signedBy` derived from the roster,
   `listingTitle` containing the player's real name) — pre-seed the
   player/team via `api.players.findOrCreate`/`api.teams.findOrCreate`
   BEFORE the commit call. Since `commitCardChecklist` resolves an
   already-existing name straight from the `players`/`teams` table
   (bypassing the batchId/decision path entirely), no `batchId` is needed
   at all for this case.
3. Only build a real `entityReviewQueue` batch (raw `ctx.db.insert` rows
   with `decision`/`enrichment` set directly, batchId passed through) when
   the test is actually exercising decision-driven create/link resolution
   itself — that's what `commitCardChecklist.entityReview.test.ts` does.

Found via this exact migration: `convex/featurePropagation.test.ts`'s BSC
per-card team-enrichment test needed `teams.findOrCreate({name: "Kansas
City Royals", sport: "Baseball"})` pre-seeded — the test's OWN comment
previously claimed "Wikidata/ESPN team enrichment legitimately fires" for
a newly-created team, but that's now FALSE: NEO-92 removed all post-commit
Wikidata/ESPN auto-enrichment from `commitCardChecklist` entirely (it now
only happens pre-commit, during the wizard) — update stale comments like
this when you find them, they'll mislead the next reader otherwise.

## Real bug found + fixed: HOF_QIDS case-mismatch

`convex/adapters/wikidata.ts`'s `lookupPlayerEnrichment` had
`const hofQid = HOF_QIDS[sport];` — un-lowercased, even though `HOF_QIDS`
is keyed lowercase (`baseball`, not `Baseball`) and the sibling
`SPORT_QIDS[sport.toLowerCase()]` two functions up already carries an
explicit comment about needing this exact normalization (a previously
already-fixed instance of the identical bug class). Every real caller
passes display-cased sport strings ("Baseball"), so `isHallOfFame` NEVER
resolved correctly before this fix — found by writing a straightforward
"isHallOfFame is true when a HoF award binding is present" unit test that
failed with `undefined` instead of `true`. Fixed to
`HOF_QIDS[sport.toLowerCase()]`, matching the sibling table's comment and
convention. This is the kind of one-line, obviously-in-scope, low-risk fix
worth making directly (with a comment explaining why) rather than only
flagging — unlike UI/behavior discrepancies (see
[[reference-carddetailpanel-dirty-guard-and-stub-children]]) which get
flagged instead of silently fixed.

## EntityLinkSearch: aria-label collision between the wrapping div and its input

`EntityLinkSearch`'s outer `<div role="listbox" aria-label="Search
existing players">` wraps an `<input aria-label="Search existing
players">` with the IDENTICAL aria-label — `screen.getByLabelText(...)`
matches both and throws "multiple elements found". Use
`screen.getByRole("textbox", { name: "..." })` to target the input
specifically (or `getByRole("listbox", ...)` for the wrapper). Same root
cause as the `getAllByLabelText` collision noted in
[[reference-reactive-field-editing-in-tests]], different fix (role
disambiguation instead of `getAllBy*`) since here the two elements have
genuinely different roles, not just repeated identical rows.
