---
name: patterns-neo335-wizard-team-answers
description: NEO-335 pre-save wizard answers on commitCardChecklist (teamIds/teamsAnswered/teamNone/teamLookup, listingTitle/listingTitleKept/cardVariationAnswered) — what holds, the fixed traps, and the open ones (client-asserted "kept" flag unbound to text; trusting internal queries left unpinned)
metadata:
  type: project
---

NEO-335 moved "fill teams" and a "Card titles" step into the entity-review
wizard, BEFORE save. Every answer rides on the preview card as an optional,
client-supplied field read by `commitCardChecklist`.

What holds (re-audited 2026-10-11), and what to re-check if it changes:
- `teamIds` re-read in the internalQuery `validateOperatorTeamIds` before any
  phase writes; sport walked from the row, never the client `sportId`; foreign
  sport refuses the commit, deleted ids dropped; per-card cap in
  `assertCardBatchWithinLimits`. `teamsAnswered` only promotes strings the
  commit itself resolved (`teamIdByName`), so it cannot name a foreign team.
- Operator fill on an existing row: fills only an EMPTY row and never a row
  ruled teamless (`teamNoneConfirmedAt`); only an accepted content change
  retires the ruling. (Both 2026-10-10 traps were fixed this way.)
- `teamNone` stamps the `requireAdmin` return as the confirming user.
- Title answers: insert vs re-sync is decided by the SERVER match
  (`existingIdByIndex`), never by the client's view, so a crafted title cannot
  land on a stored row. Title capped (trimmed) before any phase AND again in the
  chunk writer; parity with `updateCard`'s cap.
- `teamSuggestionsForPreview`: requireAdmin first, players and teamNames both
  count-capped, names length-capped, every team row sport-checked.

Open traps to look for in similar features:
- A boolean "operator kept what the step showed" flag (`listingTitleKept`) that
  suppresses an attention flag while the server REGENERATES the content: if the
  client's prediction drifts, the flag hides a result nobody saw. Bind the
  answer to the shown text (send it; suppress only on equality). See
  [[patterns-attention-flag-suppression]].
- New internalQueries that trust their args (`titleSetFacts`,
  `playerNamesByIds`) must join the "internal queries stay internal" pin block
  in `publicFunctionAuth.test.ts`; nothing else fails if one is flipped public.
- Doc comments of the form "nothing in path X ever SETS flag Y" go stale when a
  feature adds a setter. Grep for them when a new writer of a suppression flag lands.

Listing short name (`metadata.listingShortName`, re-audited 2026-10-11):
- Two doors, both `requireAdmin` and both through `normalizeListingShortName`;
  the commit door patches only `args.selectorOptionId` (the leaf it commits),
  level-checked, once per commit. No public mutation takes a metadata object
  (grep `selectorOptionMetadataFields`: schema only), so no third door.
- The trap: an operator-text normaliser copied the zero-width set from
  `selectorSyncMatch.ts` but not the bidi set `lib/marketplace/safe-text.ts`
  strips, nor C1 or U+2028/2029. Titles have NO output sanitiser, so whatever
  the normaliser admits ships in a write-once listing title. For any new
  operator text that reaches a title, ask for `\p{Cc}\p{Cf}\p{Zl}\p{Zp}` (u
  flag), and for escaped `\uXXXX` in the regex, never literal invisibles.
