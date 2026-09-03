---
name: title-fixture-arithmetic
description: Compute expected listingTitles by running the real generator (esbuild-bundle it) — and know that a flow's PLAYER_NAME never reaches the title
metadata:
  type: reference
---

Listing titles now **fill toward 80** (core → `#number` → AUTO/RELIC/parallel/
printRun/variation/RC/SP → each team name → "Rookie" → sport), so any flow that
types into `Card title`, or asserts a generated one, has a length budget worth
computing rather than eyeballing.

**Compute it, don't estimate it.** The generator is pure and has no Convex
imports, so bundle and call it:

```bash
npx esbuild convex/features/generateListing.ts --bundle --format=esm \
  --platform=node --outfile=/tmp/gen.mjs
node -e 'import("/tmp/gen.mjs").then(m=>console.log(m.assessListingTitle({
  cardNumber:"101-r2-a1-20133", year:"2024", manufacturer:"Topps",
  setName:"tlf-2-r2-a1-20133", sport:"Baseball", teamNames:["New York Yankees"]})))'
```

It returns `{title, coreFits, dropped}` — check the length AND `coreFits`, since
a cut core stamps `listingTitleTruncated`, which adds an extra **attention item**
and changes what the walker's fixer says.

**The trap that makes hand-arithmetic wrong: a flow's `PLAYER_NAME` is NOT in
the title.** `util-add-custom-card` types it into the **Card name** input (whose
placeholder merely reads "Player name"); the generator's `playerNames` come from
the separate **"Players"** field (`aria-label: "Players"`), which the util leaves
empty, so a hand-added card has `pendingPlayerNames: []`. What a custom card
DOES contribute is the typed **Team** (`pendingTeamNames`) and the **sport
ancestor's value** — e.g. `"E2E Test Sport 0"`, 16 characters, appended last.

`ATTEMPT_ID` is `<runner>-a<n>-<RANDOM>` = 7–11 chars today (`r0`..`r7`), 12 if
the CI runner matrix ever passes 9 — budget for 12.
