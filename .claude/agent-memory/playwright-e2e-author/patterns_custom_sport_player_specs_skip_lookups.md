---
name: custom-sport-player-specs-skip-lookups
description: A spec that must create MINTED player names (not recorded ones) can file them under the worker's custom sport, which has no Wikidata mapping and no real-name clashes; earlier attempts' rows stay, so count by exact name
metadata:
  type: patterns
---

`customSport(env)` ("E2E Test Sport <worker>") is a real sport in the admin Players sport select, so `addPlayerByHand(page, name, customSport(env))` works with a minted name and sends nothing to enrichment (no `sportConfig.wikidata`). The sport only exists once a custom card was added under it, so a spec that needs it first runs `addCustomCard` on `/set-selector`, then `page.goto("/admin/players")`, and `page.goBack()` returns to the set builder with the drill and card list restored.

Minted players are never deleted, so on a re-run (and desktop + mobile on one seed) the list holds earlier attempts' rows: a "how many of X" assert counts rows by exact accessible name `^<full name>\s*<sport>`, never by a first-word filter, and a message that names only the first two matches ("and N more") is not asserted for the name; the choice button is.

Used by NEO-463 `admin/player-name-fragment-asks-operator`.
