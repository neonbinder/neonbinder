---
name: key-join-rules-need-a-typeahead-reading
description: A normaliser rule that JOINS tokens (NEO-322 initials) breaks prefix typeahead on the keystroke after the run; use entityNameQueryReadings, and a player's identity in a sport has two legs (home + playerSports)
metadata:
  type: reference
---

Since NEO-322 the shared key joins runs of single letters ("C. J." → "cj").
Any typeahead that matches TYPED text as prefixes of STORED key tokens
(`teams.search` over `nameNormalized`, `players.search`'s playerSports member
leg) breaks on the keystroke where the next word's first letter joins the run:
"J. T. R" → "jtr", a prefix of nothing in "jt realmuto". Fix pattern:
`entityNameQueryReadings(raw)` in `lib/entities/normalize-name.ts` returns the
joined reading plus, only when text ends in ≥2 single letters, one with the
last letter apart. In-memory matchers accept either reading; a search-index
query asks the second reading only when the first found nothing (search is the
expensive query class).

SUBSTRING filters on an ordered key break the same way (NewTeamForm League,
TeamManagement Franchise: "N. C. S" → "ncs" is in nothing in "nc state"). Join
each reading with a space and accept `key.includes(reading)` for any — "nc s"
is a substring of "nc state". Keep the old single key for exact-match/"Create"
checks. Grep `normalizeOrderedEntityName(.*).includes(` for any new copy.

A sorted key is not idempotent under re-normalising ("J Smith K" → "j k
smith" → "jk smith"). Audited 2026-10-04: no site normalises a stored key —
keep it that way; compare keys directly or normalise the raw name.

Collision/ambiguity checks for a player "in sport S" must read BOTH legs
`sameNamePlayers` reads (players identity index for home rows +
`playerSports.by_name_normalized_and_sport_id` for members), via an owner-module
helper (`playerSportRowsByName`) because of [[alias-index-pin-exempts-reset-drain-by-name-and-position]].
