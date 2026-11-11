---
name: capture-checklist-slug-probe
description: How to find the storefront slugs for capture-bsc-checklist-teams.mjs and check a set's numbers before capturing; what makes a set a poor upload fixture
metadata:
  type: patterns
---

Find the facet slugs with the public storefront search (no login): POST `search/shop/results?q=<text>` with
`filters` of sport/year and read `aggregations.setName` / `aggregations.variantName` (each entry has a `slug`).
A set's label can differ from its slug source (BSC row `1995-96 Roanoke Express ECHL` is facet `roanoke-express-echl`;
a variant name is its own slug, e.g. `future-stars`). Filter by `setName`, `variant` and `variantName` together and
check `totalResults` against the spec's expected count before running the tool.

Before capturing for a merged NB set (one NB row over several BSC sets), compare the BSC sets' card numbers: two series
numbered 1-110 each give a file where every number is on two rows, so `checklistFacts().matched` is 0 and the upload cuts
no calls. Do not capture those.

A row whose number the parser cannot read (`TBD`) is skipped and that card is still asked of BSC live.

Pass `--cache` explicitly into the scratchpad; keep CSV outputs the only new files in `fixtures/checklists/`.
Run several sets from one script, one after another (never parallel), at `--rate 0.5`.
In zsh a bare `echo ===X` fails (`=cmd` expansion): quote it.

Related: [[patterns-published-checklist-upload-fixtures]]
