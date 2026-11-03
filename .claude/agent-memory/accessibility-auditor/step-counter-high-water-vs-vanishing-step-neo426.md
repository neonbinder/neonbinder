---
name: step-counter-high-water-vs-vanishing-step-neo426
description: EntityReviewWizard's trackSteps counter never shrinks, so any rule that can REMOVE the teams step after it was counted (teamless-sport default, async facts) leaves a phantom step in "Step x of y"
metadata:
  type: project
---

- `trackSteps`/`advanceStepCount` (entity-review-steps.ts) is a high-water mark: `teamsStep = prev || input`. Save is counted from the end, so a counted-then-vanished teams step shows as a skipped number (x jumps, y never matched).
- Teams step membership is optimistic while names are undecided and reads async queries (flagged sports, linked players). A fact that lands after the first tracked render can drop the step. Gate the step's membership on those facts being loaded, or let the count shrink with an announcement.
- Save-step explanatory text is invisible to a screen reader because focus lands straight on Confirm & Save: tie it with aria-describedby on the button (never the aria-label, E2E contract).
- Role-less `div aria-label="Set feature X"` cells are the house shape (CardPrefixRow, SlViaAllBrandsToggle); note, don't flag as new.
