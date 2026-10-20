---
name: listing-title-keep-order
description: Since 2026-10-19 the listing-title builder keeps pieces in priority order (players/insert/parallel/print run first, card number droppable); tests that squeeze the budget with a long card number no longer reach a core cut
metadata:
  type: reference
---

`buildTitle` in `convex/features/generateListing.ts` lays every piece out in
title order but KEEPS them in priority order (Jason, 2026-10-19): print run,
players, insert name, parallel name never drop; then year, set words, card
number (so the number goes before any set word: losing "Black" from "Topps
Chrome Black" names another product); then attributes; redundant words, the second "Rookie", the sport and
the labels go first. The card number is no longer the one piece that never
gives way.

Testing consequence: the old trick of padding `cardNumber` to squeeze the
budget and force a player or insert cut now just drops the number
(`dropped` gets `#<number>`, `coreFits: false`). To reach the players cut,
make the players alone exceed the cap (an unbroken leading name of growing
length); a `printRun` is kept before the players, so it can make the room odd
for the surrogate-pair slice test.

Also: a fixture whose insert name contains the sport word ("1988 Topps
Baseball Autographs") swallows the sport token via `alreadySaid`, so a
"sport dropped first" assertion needs an insert without it.

Related: [[convex-typecheck-excludes-test-files]].
