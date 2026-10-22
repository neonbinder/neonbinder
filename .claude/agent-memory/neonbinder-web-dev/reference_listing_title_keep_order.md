---
name: listing-title-keep-order
description: Listing-title builder keeps pieces in priority order (card number droppable); the parallel's repeat of its insert is one strict, all-or-nothing redundant group (2026-10-21)
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

**2026-10-21 (NEO-339 preview fixes):** a parallel leaf's value usually
carries its insert's name ("Rookie Autographs Black & White Mini-Diamond
Refractor"). `parallelRepeat` marks that leading insert repeat (in-order word
match, rookie/RC one word via `wordKey`) plus set words anywhere as one
redundant GROUP: `TitleLayout.keepAll`, kept only when nothing real was lost
(strict tier, AUTO/RELIC included). An insert that starts with the set's name
now splits into set words + its own words. The Rookie→RC build is taken only
when it loses fewer core pieces (`coreLost`) or, tied, fewer real tokens.
Fastest way to see what a rule change does to real titles: copy the HEAD and
working versions of generateListing.ts (+ listingLimits.ts) to the scratchpad
and run an old-vs-new differential with `tsx` over realistic name combos;
then copy HEAD back over the worktree file once to prove new tests go red.
