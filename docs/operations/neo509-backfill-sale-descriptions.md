# NEO-509 — backfill the card description on open BuySportsCards sales

## What it does

Since NEO-509 each BuySportsCards sale line keeps the card description BSC
sends (`marketplaceSales.items[].listed`: sport, year, set, players, card
number, variant, variant name). The Pick List uses it to name a line NB could
not match to a card ("2021 Score · Justin Fields · #TB2 · 1991 Throwback"
instead of "Unmatched sale (n of 80)") and to sort it in with its set. It is
display text on the sale only; it is never written to a card, set or player.

Sales stored before NEO-509 have no description. The 15-minute poll fills it
as it re-reads open orders, but only for the newest
`MAX_OPEN_ORDER_REFRESH` (20) open orders per round. This backfill reaches the
rest: BSC sales **still on the Pick List** (a sale status, not shipped or
cancelled), never a test seed's order, with at least one line lacking a
description. Shipped orders are not read; they are off the Pick List.

Only owners the sales poll itself polls are touched: the owner's BSC listing
state must pass `listingOutbox.pollsSales` (a saved sign-in that started
listing, not dormant, not held off by the E2E test marker). That holds for the
walk and for an `ownerId` alike, dry run included; any other owner is counted
in `ownersNotPolled` and never read.

It writes `items[].listed` and nothing else, and only on a line that has none:
`applied`, `appliedAt`, `from`, `pulledAt`, `problem`, `pullOpen`, status and
totals are never touched, nothing is applied again, and a description a line
already holds is kept. Lines are matched by card id, condition and SKU in
order, the poll's own key, so the Pick List's line ids do not move. Each
description goes through the poll's store rules (length bounds, NB's sport
resolved by its BSC id, the per-sale byte budget).

## Arming

Two arms, the NEO-214 pair: `"confirm":"BACKFILL"` on the call and
`ALLOW_SALE_LISTED_BACKFILL=1` on the deployment. Without **both** it is a dry
run that writes nothing and makes **no BuySportsCards call** (it does not even
read a token). The write re-checks the flag itself.

It is an internal function, so **no `--identity`** (that hides internal
functions from `convex run`; the deploy credential is the gate). Every command
below runs from `!` (no prompt, no TTY).

Armed, one call's BuySportsCards contact is bounded three ways:

- **At most 5 session opens per call.** One session per owner; every open
  attempt counts, a failed one too (a token read can be a BSC sign-in through
  the browser service). A walk page holds at most 5 owners, so the walk never
  stalls on this limit.
- **At most `maxOrders` order reads per call** (default 5, capped at 20), one
  at a time, about a second apart.
- **About 8 minutes.** After 8 minutes from the call's start no session is
  opened and no read is started; what is left counts in `ordersLeft`. A read
  already under way finishes within its own 30-second timeout (plus, at most
  once per session, a BSC sign-in and one retry after a 401), so the call ends
  and closes its session inside Convex's 10-minute action limit.

So a call makes at most 5 session opens and 20 order reads, plus at most one
re-sign-in and retry per session opened.

An owner BSC has signed out is skipped (`"stopped": "signed_out"`). An owner
whose reads fail twice in a row on a timeout, a network error or a 5xx is
skipped too (`"stopped": "unavailable"`); a good read in between resets the
count. A 429 from BSC stops the whole call (`"stopped": "rate_limited"`). Wait
a few minutes before the next call after a 429 or an `unavailable`.

## Running it

From `apps/web`.

**Unset `CONVEX_DEPLOY_KEY` first, in the shell and in `apps/web/.env.local`.**
A deploy key picks the deployment the CLI talks to and overrides `--prod`, so
with one set these commands run against whatever deployment the key names.
Check before step 1 (prints nothing when clear):

```bash
cd apps/web
unset CONVEX_DEPLOY_KEY CONVEX_DEPLOYMENT_TOKEN
grep -nE '^CONVEX_(DEPLOY_KEY|DEPLOYMENT_TOKEN)=' .env.local
```

If the `grep` prints a line, comment it out for the run and restore it after.

**Keep the results private.** The report lists owners by user id
(`byOwner[].ownerId`, and the dry run's list is a list of sellers). Do not
paste it into a PR, a Linear ticket or any public thread; give counts only
(`orders`, `linesFilled`, `ordersLeft`) where others will read them.

```bash
# 1. Dry run on prod. Writes nothing, contacts nothing. Lists the owners with
#    open sales missing descriptions, by owner id, one page of owners per call.
npx convex run --prod saleListedBackfill:fillMissing '{}'

#    More owners: pass the returned nextCursor until "complete": true.
npx convex run --prod saleListedBackfill:fillMissing '{"cursor":"<nextCursor>"}'

#    One owner only (dry run):
npx convex run --prod saleListedBackfill:fillMissing '{"ownerId":"<ownerId>"}'

# 2. Arm, then check the flag really is set before writing.
npx convex env set --prod ALLOW_SALE_LISTED_BACKFILL 1
npx convex env get --prod ALLOW_SALE_LISTED_BACKFILL

# 3. Run for one owner. Re-run the same command until "complete": true
#    ("ordersLeft": 0). Up to 20 orders per call with maxOrders.
npx convex run --prod saleListedBackfill:fillMissing \
  '{"confirm":"BACKFILL","ownerId":"<ownerId>","maxOrders":20}'

# 4. Disarm, and check it is gone.
npx convex env remove --prod ALLOW_SALE_LISTED_BACKFILL
npx convex env get --prod ALLOW_SALE_LISTED_BACKFILL
```

To fill every owner instead of one, arm as in step 2 and walk the owners by
cursor, then disarm:

```bash
npx convex run --prod saleListedBackfill:fillMissing '{"confirm":"BACKFILL","maxOrders":20}'
npx convex run --prod saleListedBackfill:fillMissing \
  '{"confirm":"BACKFILL","maxOrders":20,"cursor":"<nextCursor>"}'
```

Keep calling until `"complete": true`. When a call returns `"complete": false`
with `"nextCursor": null`, call again **without** a `cursor` (it stopped on the
first page and redoes it; the owners it filled have nothing left there).

An armed `confirm` on an unarmed deployment is **reported**, not thrown:
`"mode": "refused"`, a message saying the deployment is not armed, and the dry
run's counts. Nothing was written and BSC was not contacted. Arm (step 2) and
run again.

## Reading the result

```json
{
  "mode": "armed",
  "owners": 1, "ownersNotPolled": 0, "orders": 3, "linesMissing": 80,
  "sessionOpens": 1, "ordersRead": 3, "linesFilled": 78, "linesStillMissing": 2, "ordersLeft": 0,
  "byOwner": [{ "ownerId": "...", "orders": 3, "linesMissing": 80, "ordersRead": 3,
                "linesFilled": 78, "linesStillMissing": 2, "ordersFailed": 0 }],
  "complete": true, "nextCursor": null
}
```

- `mode`: `dry_run`, `refused` (confirm given, deployment not armed) or `armed`.
- `owners`, `orders`, `linesMissing`: the candidates found before this call
  wrote anything (owners with at least one, open BSC orders with a line lacking
  a description, and those lines).
- `ownersNotPolled`: owners skipped because the sales poll does not poll them
  on BSC (dormant, never started, held off by the E2E marker, or no BSC
  listing state). They are never counted or read.
- `sessionOpens`: BSC session open attempts, failed ones included (at most 5;
  always 0 on a dry run or a refusal).
- `ordersRead`: BSC order reads made (always 0 on a dry run or a refusal).
- `linesFilled`: lines that got a description.
- `linesStillMissing`: lines on the orders read that still have none, because
  BSC's read did not describe them, or the sale's description budget was spent.
  A re-run will not change them.
- `ordersLeft`: candidate orders this call did not reach (`maxOrders`, the
  5-open limit, the 8-minute limit, or a stop). Non-zero means call again.
- `byOwner[].stopped`: why an owner stopped early: `signed_out` (the owner must
  sign in to BSC again under Profile), `no_token`, `rate_limited` (a 429; the
  call stopped), `unavailable` (two timeout, network or 5xx reads in a row;
  the owner was skipped), `paused` (BSC is paused on NB; the call stopped).
- `byOwner[].ordersFailed`: orders BSC would not return (a timeout, a bad
  answer). They stay candidates for the next call.

It is idempotent: a line once filled is never a candidate again, so a second
run over the same owner reports `"orders": 0`, or only orders whose remaining
lines BSC does not describe.

## Retiring it

This is a one-time repair. Once a dry run on prod reports `"orders": 0` (or
only orders an armed run reports as `linesStillMissing`, which no re-run can
fill), delete `apps/web/convex/saleListedBackfill.ts` and its test, make sure
`ALLOW_SALE_LISTED_BACKFILL` is not set on any deployment, and cut this
runbook down to a note that it ran and was retired (as NEO-358's does). Orders that are still open then are either filled or will be
re-read by the poll.
