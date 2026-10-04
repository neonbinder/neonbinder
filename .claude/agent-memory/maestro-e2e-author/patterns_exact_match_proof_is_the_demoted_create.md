---
name: exact-match-proof-is-the-demoted-create
description: On /admin/players (and the wizard's twin), "Open <name>" renders for a CLOSE match too (as a near-match panel row) — only the demoted `Create player <typed> anyway` aria-label is exact-only; and a seeded-roster name is verified from the enrichment recording + the set's public checklist, never from dev (dev holds no seeded roster)
metadata:
  type: reference
---

**Asserting an EXACT key match on the add-player form.** `AddPlayerForm`
promotes the exact row to the primary button (`Open <name>`, visible text,
no aria-label) and adds `Create player <typed> anyway` (aria-label). But a
CLOSE match also renders an `Open <name>` button — in `NearMatchPanel`, below
the form. So `Open …` visible proves nothing about exactness; the
`… anyway` control does, and `id: "Create player <typed>"` going absent is
the negative (full-match `id:` cannot hit the `… anyway` label). Used in
`admin/player-add-spaced-initials-opens-roster-row.yaml` (NEO-322). Assert
the positive first, then the negative ([[negative-asserts-pass-on-a-dead-page]]).

**Verifying a name is in the seeded roster without a seeded backend.** The
local dev deployment carries no 2024 Topps Chrome roster (a few hundred
hand-made/bulk rows), so `npx convex data players` there proves nothing.
What works read-only: `convex/adapters/__fixtures__/enrichment-lookups.json`
holds every player name the committed sets produced (and their spelling as
committed), then confirm the card is in the seed set from its public
checklist (a web search for "<set> <player> card number"). Exclude names
other committing flows could also produce
([[real-person-fixture-names-collide-with-committed-checklists]]).
`npx convex data <table> --limit` caps below 50001 (8000 works).
