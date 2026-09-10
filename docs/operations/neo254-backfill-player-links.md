# NEO-254 — backfill `cardChecklist.playerLinks`

## What it does

Every card now records the name it was **printed** with for each player
(`cardChecklist.playerLinks`), beside the `playerIds` it already had. A 1986
card says "Doc Gooden" and a 1990 card says "Dwight Gooden"; both link to one
player row, and the printed string is the card's own fact — renaming or
re-aliasing the player must never rewrite what a 1986 card says.

Rows written before the field have `playerIds` and no `playerLinks`. There is
nowhere to recover what they actually said: the checklist payload that produced
them is long gone. So the backfill writes the player's **canonical name**, which
is the honest answer — "this card links to Dwight Gooden, and nobody kept what
it printed". The card detail panel then shows no "As printed" line for those
rows, which is correct: we do not know that they printed anything else.

## Running it

Armed by an env flag as well as a `confirm` literal, like every other scripted
admin task (NEO-214). The flag is asserted **inside** the mutation, so there is
no door around it.

```bash
# 1. Arm the deployment.
npx convex env set ALLOW_BACKFILL_PLAYER_LINKS true --prod

# 2. Run it. Chunked and resumable: feed `nextCursor` back as `cursor`
#    until the result has no `nextCursor`.
npx convex run selectorOptions:backfillPlayerLinks \
  '{"confirm":"BACKFILL_PLAYER_LINKS"}' --prod

npx convex run selectorOptions:backfillPlayerLinks \
  '{"confirm":"BACKFILL_PLAYER_LINKS","cursor":"<nextCursor from the last run>"}' --prod

# 3. Disarm.
npx convex env remove ALLOW_BACKFILL_PLAYER_LINKS --prod
```

`batchSize` defaults to 200 and is capped at 500 — each row costs one read,
plus one read per distinct player on the page (cached) and one patch.

## Reading the result

```
{ "scanned": 200, "filled": 173, "nextCursor": "..." }
```

- `scanned` — rows visited this call, including ones that needed nothing.
- `filled` — rows actually patched.
- `nextCursor` — **absent when the table is exhausted**. That is the exit
  condition; `filled: 0` on its own is not, because a page can legitimately
  contain only rows that already have links or carry no players.

## Idempotency and safety

- A row that already has `playerLinks` is **skipped**, never rewritten — so a
  re-run after a partial pass costs one read per row and writes nothing, and a
  name the commit path already recorded is never replaced by the canonical one.
- A row with no `playerIds` is skipped.
- A `playerIds` entry pointing at a player that no longer exists is left **out**
  of `playerLinks` and left **in** `playerIds`. This migration adds a field; it
  does not prune a card's links behind an operator's back. The attention walker
  is what surfaces a card pointing at a missing player.
- Safe to run before or after the code deploy: the field is optional and every
  reader treats its absence as "no printed name kept".
