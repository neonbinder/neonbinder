---
name: reference-identify-a-same-name-catalogue-player-read-only
description: How to tell which of several same-name catalogue players a seed card shows, read-only, when the reference bundle is a private prod-data download and the repo's Wikidata fixture guesses wrong
metadata:
  type: reference
---

To decide a seed spec's `{ link, birthYear }` answer (NEO-339), read the
facts off a PR preview that already ran the seed. Do not download the
reference bundle: it is prod data in a private bucket.

- **Preview slug:** the Vercel preview is protected, so the index page's
  `x-convex-url` is unreadable without the bypass secret. The PR Pipeline
  run log prints it: `gh run view <pr-pipeline run id> --log | grep -oE
  "Convex deployment: [a-z0-9-]+"`. The slug goes in the report's Private
  notes, never in memory.
- **Read-only query:** `npx convex run --deployment <slug> --codegen disable
  --typecheck disable --inline-query '…'` is sandboxed read-only. Use
  `players` `by_name_normalized_and_sport_id` with the key folded and
  token-sorted ("José Rodriguez" → `jose rodriguez`). It returns
  `birthYear` and `teamYears` (resolve `teamId` → `teams`). The card side is
  in `cardChecklist`: `listingTitle` carries year, set, number, RC flag and
  team ("2024 Topps Chrome Jose Rodriguez #115 RC Chicago White Sox").
  `playerIds` points at the row the seed created.
- **Also check** `playerAliases` and `playerSports` for the same key. Both
  feed `players.nearMatches`' exact leg.
- **Do not trust** `convex/adapters/__fixtures__/enrichment-lookups.json` for
  this. Its Wikidata entry for a common name can be a different man; for Jose
  Rodriguez it held the one born in 1894.
- Only one PR run may be in flight while you read: a seed resets the preview
  ([[ci-seed-resets-the-branch-convex-preview]]).
