---
name: title-fixture-arithmetic
description: Compute expected listingTitles by running the real generator (esbuild-bundle it) — and know that a spec's typed player name never reaches the title via the Card name field
metadata:
  type: reference
---

Listing titles **fill toward 80** (core, then `#number`, then AUTO/RELIC/parallel/
printRun/variation/RC/SP, then each team name, then "Rookie", then sport), so any
spec that types into `Card title`, or asserts a generated one, has a length budget
worth computing rather than eyeballing.

**Compute it, don't estimate it.** The generator is pure and has no Convex
imports, so bundle and call it (from `apps/web`, output to the scratchpad):

```bash
npx esbuild convex/features/generateListing.ts --bundle --format=esm \
  --platform=node --outfile=<scratch>/gen.mjs
node -e 'import("<scratch>/gen.mjs").then(m=>console.log(m.assessListingTitle({
  cardNumber:"101-r2-a1-20133", year:"2024", manufacturer:"Topps",
  setName:"tlf-2-r2-a1-20133", sport:"Baseball", teamNames:["New York Yankees"]})))'
```

It returns `{title, coreFits, dropped}`: check the length AND `coreFits`, since a
cut core stamps `listingTitleTruncated`, which adds an extra **attention item**
and changes what the walker's fixer says.

**The trap that makes hand-arithmetic wrong:** the player name typed through the
hand-made card helper (`addCustomCard` in `support/cards.ts`) goes into the
**Card name** field (whose placeholder merely reads "Player name"); the
generator's `playerNames` come from the separate **"Players"** field, which the
helper leaves empty, so a hand-added card has `pendingPlayerNames: []`. What a
hand-made card DOES contribute is the typed **Team** (`pendingTeamNames`) and the
**sport ancestor's value** (e.g. a 16-character hand-made sport name), appended
last. A minted name built from `ATTEMPT_TOKEN` has its own length; measure the
real value in the run rather than assuming.
