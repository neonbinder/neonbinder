---
name: full-local-run-on-one-account
description: What goes red only because a whole-suite local run puts every spec on ONE worker account and one seed, and how to separate it from real reds
metadata:
  type: pattern
---

A full local run (`--project=e2e|e2e-mobile --no-deps --grep-invert @marketplace-seller`,
`WORKER_INDEX=0`, `--output=<scratch>` so failure artifacts survive) squeezes what CI
spreads over 8 accounts onto one. Reds that are the run, not the product:

- **Add cards start cap** (12 starts per hour per user): the first zip/photo specs go red
  with "you have started 12 batches" in the failure snapshot. On your own deployment
  `npx convex env set MAX_JOB_STARTS_PER_WINDOW 100`, rerun those specs.
- **Env switches CI sets on the preview** (`e2e.yml` "env set" steps) are not on a
  per-worktree deployment: `NEONBINDER_TEST_BSC_STALL_CARD_IDS` (the stall spec says
  "the deployment's ... is unset" by name). Set them from the workflow's own values.
- **A fresh-only spec that failed once is dirty**: its rerun fails at the first
  precondition ("No cards in this checklist yet", "None yet" on a shared ordinary row).
  Re-seed (reset + setup + bootstrap) for a hand-made-set spec; bootstrap alone clears
  the account's binders, boxes and copies for a spec that only wrote account rows.
  A red that precedes a "None yet" red on the same card row is the cause of it.
- **Box clutter**: seed hops and inventory specs leave `PhotoFixture-*`/Unsorted boxes;
  the dashboard's third shelf shows 3 ends on a phone / 5 on a desktop, then "N more
  boxes on My Boxes", and boxes stand in creation order (Unsorted first). A spec that
  needs ITS box's end on the shelf must fall back to My Boxes (a second page) or it is
  red on whichever CI shard collects 3+ leftovers. Prove such a fallback by planting a
  wrong count AFTER making clutter (a throwaway spec that creates boxes, then `rm` it).
- **A "newest N" list** (New on NeonBinder shows 6 checklist loads) never holds a
  seed-time fixture once other specs have written; make the spec write its own newest.
- **Near-budget photo steps**: "Added ... with its front and back photos" waits for four
  sequential R2 PUTs (~0.8 s each from a laptop) so it lands at ~7 s locally; read the
  PUT durations from the failure's trace.network before calling it a regression. It is
  a measurement, never a reason to raise the 7 s.

Reading a failure's trace without the viewer: `unzip trace.zip`, then the `*.trace`
ndjson (`before`/`after` actions with `startTime`) and `*.network` (`_monotonicTime`,
`time`) share one clock; `screencast/*.jpeg` frames are timestamped in the file name.
