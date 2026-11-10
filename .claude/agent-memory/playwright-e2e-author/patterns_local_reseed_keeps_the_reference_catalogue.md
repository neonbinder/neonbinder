---
name: patterns-local-reseed-keeps-the-reference-catalogue
description: A local re-seed of a per-worktree Convex deployment must reload the reference catalogue; a plain baseline reset wipes it, and a spec that is neither fresh-only nor a sole writer needs no re-seed between projects
metadata:
  type: reference
---

`./e2e-baseline.sh reset` clears ALL tables, the eight reference-seed tables
included. A deployment seeded with the reference catalogue (CI previews, a
per-worktree deployment) gets it back only through `e2e-seed-reset.sh` with
`NB_REFERENCE_BUNDLE` pointing at the bundle. That fetch needs a live `gcloud`
token, and with none the script refuses before it touches anything (safe).
Never fall back to the plain reset: the catalogue stays gone until someone can
fetch the bundle.

**Why a re-seed exists between `e2e` and `e2e-mobile`:** fresh-only and
sole-writer specs pass once per seed. A spec that writes only the worker's own
rows under minted names and cleans up after itself (public-share-link) runs on
both projects on one seed; `bootstrap` alone clears the account. Say in the
report that the re-seed was skipped and why.

**Keep artifacts:** the next run empties `playwright/results`, so a red's
`error-context.md` is gone once anything else runs. Pass
`--output=<scratch dir>` to any run you may need to read back, the seed included.

Related: [[patterns_reference_catalogue_on_ci_previews]]
