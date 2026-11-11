---
name: checklist-upload-team-claim-blocks-career-prefill
description: NEO-478 — an uploaded publisher's checklist makes every matched row's team a permanent claim; a spec that proves a wizard pre-fill (career team) or relies on a skipped team name releasing the claim cannot take the upload
metadata:
  type: pattern
---

A team named by an uploaded checklist row is a data claim that stays
(`checklistClaim` in `components/SetSelector/teams-on-cards.ts`, invariant 8): no
rule fills another team over it, and SKIPPING the New Team step does not release
it. A live BSC per-card answer is different: its team string is a claim only
until the operator rules the name "not a team" (the skip), then the normal rules
(career pre-fill) apply again.

**Why:** `checklist-one-marketplace-skips-match-dialog` uploaded the Roanoke file
(25 NNO rows, team "Roanoke Express" each) and went red at STEP 6: the created
player's in-window career team (`Templetuohy`) stayed UNCHECKED, every line on
"Leave for later". The same spec on a live fetch passed in three passes. The
checklist was put back out of the spec; the file stays as a fixture.

**How to apply:** before wiring an upload into a spec, list what it asserts about
teams. Pre-fill, "N need you", and teams-only re-sync lines all change under a
claim. An upload suits a spec whose point is something else (autograph format,
set history, a stall) and whose team answers it only reads back.

Related: a dialog button that is `aria-disabled` while there is nothing to use
(the checklist dialog's "Use this checklist") cannot be `click()`ed (7 s
actionability wait); focus it and press Enter to see the product's refusal
status. Another live-call burst note: two fetches of 25 cards back to back
(one spec) left BSC answering 429 to the NEXT spec's whole first wave of 10, on
desktop and mobile alike; the card-listing cooldown row showed 15 s, streak 1.
