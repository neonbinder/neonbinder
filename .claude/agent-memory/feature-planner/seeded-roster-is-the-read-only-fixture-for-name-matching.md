---
name: seeded-roster-is-the-read-only-fixture-for-name-matching
description: E2E for a name-matching/normalisation feature probes the roster setup.yaml commits every run, read-only, via the Players admin add form's "Open <name>" demotion; never mint a multi-token name to get a spelling variant
metadata:
  type: project
---

When a feature changes how a typed or printed name matches an existing
player (normalisation, initials, diacritics, aliases), plan the E2E as a
READ-ONLY probe of the roster `setup.yaml` commits at the head of every run
(the 2024 Topps Chrome Base checklist; `checklist-wizard-link-to-existing-player.yaml`
is the precedent). Type a variant spelling into the Players admin "New player
name" field: on an exact key match the primary button becomes `Open <roster
name>` and creation demotes to `Create player <typed> anyway`; before the fix
it stays `Create player <typed>`. That demotion is the sharp R2 assertion.

**Why:** minted E2E names are single tokens with no exceptions, so a flow
cannot mint "C. J. <token>"; a real checklist sync puts the spelling in a
marketplace's hands; a read-only probe writes nothing, needs no cleanup and
is safe alongside every other flow. Planned this way for NEO-322 (spaced vs
unspaced initials).

**How to apply:** pick the roster name from the committed enrichment
recording (`convex/adapters/__fixtures__/enrichment-lookups.json`), list
fallbacks, have the E2E author verify the name is in the seeded commit first,
assert its presence as a precondition with a readable failure, and cite the
seed dependency in the flow header.
