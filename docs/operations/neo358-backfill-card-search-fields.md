# NEO-358 — backfill the collector's catalog fields

The real `/collection` reads four things off the catalog that older rows do
not carry. Each has its own armed backfill, in the NEO-214 shape: a **dry run
by default**, a typed `confirm`, and a deployment flag of its own. Run all
four after the NEO-358 deploy, in this order, on every deployment that holds
real cards (prod; a preview is reseeded and needs none). The subtree counts
are summed from the card counts, so they go **last**, after the card counts
report `"complete": true`.

| Backfill | Fills | Flag | Command |
|---|---|---|---|
| card search fields | `cardChecklist.listingTitle` (absent or blank) and `cardChecklist.sportId` | `ALLOW_CARD_SEARCH_FIELDS_BACKFILL` | `backfillCardSearchFields:backfillCardSearchFields` |
| team links | `cardTeamLinks`, from each card's `teamOnCardIds` | `ALLOW_CARD_TEAM_LINKS_BACKFILL` | `cardTeamLinks:backfillCardTeamLinks` |
| card counts | `selectorOptions.cardCount` and `nonVariationCardCount` on every variant type, insert and parallel | `ALLOW_CARD_COUNT_BACKFILL` | `cardCounts:backfillVariantCardCounts` |
| subtree counts | `selectorOptions.subtreeCardCount` and `subtreeNonVariationCardCount` on every row, sport down to parallel | `ALLOW_SUBTREE_CARD_COUNT_BACKFILL` | `cardCounts:backfillSubtreeCardCounts` |

All four are idempotent: a second run reports zeros. All four are internal
functions, so **no `--identity`** (it hides internal functions from
`convex run`; the deploy credential is the gate, see the NEO-214 doc).

## Running one

The same three steps for each; shown for the search fields.

```bash
cd apps/web

# 1. Dry run. Writes nothing, needs no arming, reports what an armed run would do.
npx convex run --prod backfillCardSearchFields:backfillCardSearchFields '{}'

# 2. Arm, run for real, disarm.
npx convex env set --prod ALLOW_CARD_SEARCH_FIELDS_BACKFILL 1
npx convex run --prod backfillCardSearchFields:backfillCardSearchFields '{"confirm":"BACKFILL"}'
npx convex env remove --prod ALLOW_CARD_SEARCH_FIELDS_BACKFILL
```

Each call works for about 2.5 minutes and then returns `"complete": false` with
a `cursor`. Re-run with that cursor until it prints `"complete": true`:

```bash
npx convex run --prod backfillCardSearchFields:backfillCardSearchFields \
  '{"confirm":"BACKFILL","cursor":"<cursor from the last run>"}'
```

An armed `confirm` on an unarmed deployment is **reported**, not thrown: the
`message` says "Refused: this deployment is not armed", `armed` is `false`, and
the counts are still the dry run's.

## Reading the results

**Card search fields** — `{ scanned, titlesFilled, sportFilled, noSport }`

- `titlesFilled`: cards whose title was absent or blank, now carrying the title
  the card detail panel's Regenerate would offer (one implementation,
  `storedCardTitle.titleForStoredCard`). A title that is already there is never
  touched: it may be an operator's.
- `sportFilled`: cards given the sport at the root of their selector chain.
- `noSport`: cards whose chain reaches no sport row. Left alone and counted
  every time; each is orphaned data for an operator to look at.

The next PR makes `listingTitle` required. Do not merge it until this backfill
reports `titlesFilled: 0` on a dry run against prod.

**Team links** — `{ scanned, cardsChanged, rowsInserted, rowsDeleted }`

`cardsChanged` counts cards whose rows did not match their `teamOnCardIds`; a
card that lists one team twice gets one row.

**Card counts** — `{ scanned, filled, disagreed, repaired }`

- `filled`: rows missing either count; both are written together.
- `disagreed`: rows whose stored counts do not match a recount. Left alone by
  default. Pass `"repair": true` to rewrite them:

  ```bash
  npx convex run --prod cardCounts:backfillVariantCardCounts '{"confirm":"BACKFILL","repair":true}'
  ```

  After the first fill, a non-zero `disagreed` means a writer forgot its
  ledger: report it, then repair. `cardCounts.pin.test.ts` is meant to make
  that impossible.

A row with more than 10,000 cards refuses its page ("count it by hand"); no
real checklist is that large.

**Subtree counts** — `{ scanned, filled, disagreed, repaired, waiting }`

Run only after the card counts backfill reports `"complete": true`. It walks
the levels deepest first (parallel, insert, variant type, set, brand, year,
sport) and writes each row's own counts plus its children's subtree counts.

- `filled`: rows missing either subtree count; both are written together.
- `waiting`: rows left alone because a child's subtree count was still
  unknown. On an armed run this should be 0; re-run until it is. A **dry run
  always reports waiting rows** above the deepest level it could not fill (it
  writes nothing for the next level to read), so judge a dry run by `filled`
  at the leaves, not by `waiting`.
- `disagreed` / `repaired`: as for the card counts; `"repair": true` rewrites
  a stored subtree count that disagrees with the sum of its children.

  ```bash
  npx convex run --prod cardCounts:backfillSubtreeCardCounts '{"confirm":"BACKFILL","repair":true}'
  ```

A `repair` of the card counts above is always followed by a `repair` run of
this one: a writer that missed its ledger left both wrong, and the subtree
counts are summed from the repaired card counts.

Until this has run, the collector's drill shows every level (an unknown count
is never hidden); after it, a level with no cards anywhere beneath it is
hidden. A row with more than 5,000 rows beneath it refuses its page ("sum it
by hand").

## What keeps them right afterwards

- `sportId` is stamped at insert (`insertCardRow`, `addCustomCard`) and never
  changes.
- `listingTitle` can no longer be saved blank (`updateCard` refuses it).
- `cardTeamLinks` is kept by `syncCardTeamLinks` at every `teamOnCardIds`
  write, and removed by `removeCardRow` with each card.
- The counts are kept by a per-mutation `CardCountLedger` at every card
  insert, delete and move, and every change of a card's variation parent. A
  row whose count is absent is recounted in place on its next write, so a row
  the backfill has not reached yet is never written wrong.
- The subtree counts are kept by the same ledger flush, up every row's
  `parentId` chain, and moved with a row re-parented under a new brand or
  insert. New rows are born at 0. An absent subtree count stays absent (it is
  never recounted inside a mutation) until this backfill fills it; a stored
  one that would go negative is cleared to absent and logged
  `subtree_card_count_drift`, so a re-run (with `repair` if `disagreed` is
  non-zero) puts it back.
