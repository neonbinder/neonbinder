---
name: project_neo208_shared_helper_test_patterns
description: NEO-208 (pending team names) adversarial-pass test patterns — shared-helper parity, write-once-vs-live-preview split, deriveCardAttention OR-semantics pin
metadata:
  type: reference
---

Patterns from the NEO-208 adversarial unit-test pass
(`convex/cardChecklist.noTeam.test.ts`, `convex/enrichmentCreationOnly.test.ts`,
`components/SetSelector/CardChecklist.test.tsx`,
`components/SetSelector/CardChecklistItem.test.tsx`), useful for future
`selectorOptions.ts` / `teams.ts` / checklist-UI work.

## Shared-helper parity testing
`addCustomCard` and `updateCard` both validate `teamOnCardIds` through one
extracted function, `resolveTeamOnCardIdsForWrite`. Rather than duplicating
every case for both mutations, drive the SAME edge case through both and
assert they agree — e.g. a card whose `selectorOptions` ancestor chain has no
resolvable `level: "sport"` row (`findSportForSelectorOption` returns
`undefined`): the sport check is then skipped entirely (documented behavior,
not a bug), so both mutations accept a team from ANY sport. One test builds
an orphan leaf (`ctx.db.insert("selectorOptions", {..., no parentId})`),
calls `addCustomCard` on one card and `updateCard` on a second, and asserts
both stored `teamOnCardIds` match.

## Write-once title vs. live preview — the split to pin together
`addCustomCard` computes `listingTitle`/`listingDescription` ONCE at insert
(mirrors `writeOnceFeatureSnapshots.test.ts`'s write-once semantics). A team
rename afterward does NOT change the stored `row.listingTitle`. But
`previewListingTitle` (the Regenerate-button query) resolves team names LIVE
via `ctx.db.get` on every call, so it DOES pick up the rename. Test both
halves in one test so a future change that breaks either symmetry is caught:
rename the team, assert `row.listingTitle` unchanged, then query
`previewListingTitle` and assert `inputs.teamNames` reflects the new name.

## `deriveCardAttention`'s OR semantics — a stale-row combination is reachable
`missingTeam` clause: `hasTeam = teamOnCardIds.length>0 || pendingTeamNames.length>0`.
A row can carry BOTH (an old row linked some way other than `updateCard`,
which is the only path that clears `pendingTeamNames`, and only on a
non-empty write). This is not flagged either way — pin it as one test rather
than leaving it implicit. Correspondingly, `CardChecklistItem`'s pending-name
render loop is unconditional (`for (const n of card.pendingTeamNames ?? [])`)
— it does NOT hide pending names once `teamOnCardIds` is also present, so a
stale row can show a resolved team label AND "(unconfirmed)" text together.
Pinned as documented current behavior, not asserted as ideal.

## `normalizePendingNames` cap-splitting pattern
When one helper function enforces a count cap shared across two argument
kinds with different real-world limits (teams vs. players on a card), pass
the limit as a parameter rather than reading a shared module constant — see
`MAX_PENDING_TEAM_NAMES` (= `MAX_CARD_TEAMS`, 8) vs.
`MAX_PENDING_PLAYER_NAMES` (20, independently chosen). Update BOTH the
over-cap rejection test AND add an at-the-new-cap acceptance test so the
split isn't just asserted at the old shared value.

## `teams.findOrCreate` — testing the audit log without over-specifying it
The `team_created` console.log line is `JSON.stringify({msg, teamId, sportId,
userId})`. Test it by `vi.spyOn(console, "log")`, filtering
`mock.calls` for a line containing `"team_created"`, then `JSON.parse`-ing
that ONE line and asserting on the parsed object (`toMatchObject`) — this
proves it's actually valid JSON (a concatenated string would fail to parse)
without hardcoding field order. Pair with a negative test: a FOUND (not
created) team logs no such line at all.

## Component test: TeamPicker's "Create team" flow needs a stateful mock
`components/SetSelector/CardChecklist.test.tsx` mocks `teams.list` and
`teams.getManyByIds` off the same `state.teams` array (both routed through
the string-ref `useQuery` mock). To test creating a NEW team from the
popover, give `mockFindOrCreateTeam` a `mockImplementation` that pushes the
new `{_id, name}` onto `state.teams` as a side effect before resolving — the
picker's `addChip` then re-renders and `getManyByIds` resolves the label from
the now-updated array, without needing a real Convex reactive subscription.

See also [[feedback_concurrent_agent_commit_scoping]] for the git workflow
lesson from the same session.
