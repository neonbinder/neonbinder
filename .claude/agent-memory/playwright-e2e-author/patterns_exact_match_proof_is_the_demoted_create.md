---
name: exact-match-proof-is-the-demoted-create
description: On /admin/players (and the wizard's twin), "Open <name>" renders for a CLOSE match too (as a near-match panel row) — only the demoted `Create player <typed> anyway` aria-label is exact-only; and a seeded-roster name is verified from the enrichment recording + the set's public checklist, never from dev
metadata:
  type: reference
---

**Asserting an EXACT key match on the add-player form.** `AddPlayerForm` promotes
the exact row to the primary button (`Open <name>`, visible text, no aria-label)
and adds `Create player <typed> anyway` (aria-label). But a CLOSE match also
renders an `Open <name>` button, in `NearMatchPanel` below the form. So an `Open
...` button proves nothing about exactness; the `... anyway` control does, and
`getByRole("button", { name: "Create player <typed>", exact: true })` going absent
is the negative. Assert the positive first, then the negative (see
[[negative-asserts-pass-on-a-dead-page]]).

**Verifying a name is in the seeded roster without a seeded backend.** The local
dev deployment carries no 2024 Topps Chrome roster, so `npx convex data players`
there proves nothing. What works read-only:
`convex/adapters/__fixtures__/enrichment-lookups.json` holds every player name the
committed sets produced (and their spelling as committed); then confirm the card
is in the seed set from its public checklist (a web search for "<set> <player>
card number"). Exclude names other committing specs could also produce
([[real-person-fixture-names-collide-with-committed-checklists]]).
`npx convex data <table> --limit` caps below 50001 (8000 works).
