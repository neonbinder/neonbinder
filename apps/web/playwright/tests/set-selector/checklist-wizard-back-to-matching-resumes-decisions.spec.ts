// Port of .maestro/flows/set-selector/checklist-wizard-back-to-matching-resumes-decisions.yaml
import { test } from "../../support/fixtures";
import { utilFetchRealSetChecklistToWizard } from "../../support/subflows/set-selector/util-fetch-real-set-checklist-to-wizard";
import { utilDiscardResumedReviewBatch } from "../../support/subflows/set-selector/util-discard-resumed-review-batch";
import { utilWizardWalkToPlayerRow } from "../../support/subflows/set-selector/util-wizard-walk-to-player-row";

test(
  "Entity review — Back to matching leaves the wizard without discarding, and re-confirming comes back to the same review with the decision still on it",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilFetchRealSetChecklistToWizard(m);

    if (!env.SL_PAUSED) {
      // STEP 1 — the review starts with nothing decided
      await utilDiscardResumedReviewBatch(m);
      await m.assertVisible("0 of [0-9]+ reviewed.*");

      // STEP 2 — take exactly ONE decision
      await utilWizardWalkToPlayerRow(m);
      await m.tapOn(m.id("Add as New Player"));
      await m.waitVisible("Added as new");
      await m.assertVisible("Decided \\([0-9]+\\)");

      // STEP 3 — leave review WITHOUT discarding it
      await m.tapOn("Back to matching");
      await m.waitNotVisible("Confirm New Players & Teams");
      await m.assertVisible(m.id("Confirm card matches"));

      // STEP 4 — re-confirm, and the SAME review comes back
      await m.tapOn(m.id("Confirm card matches"));
      await m.waitVisible("Confirm New Players & Teams", 60_000);
      await m.assertVisible("Added as new");
      await m.assertVisible("Decided \\([0-9]+\\)");

      // STEP 5 — exit without writing anything
      // Parens escaped: the button reads literally "Cancel (Esc)".
      await m.tapOn("Cancel \\(Esc\\)");
      await m.assertVisible("Discard [0-9]+ decisions?.*");
      await m.tapOn("Discard");
      await m.waitVisible("Fetch cancelled — no cards saved.");
    } else {
      await utilDiscardResumedReviewBatch(m);
      await m.assertVisible("0 of [0-9]+ reviewed.*");
      await m.assertVisible("Cancel \\(Esc\\)");
      await m.assertNotVisible("Back to matching");
      await m.tapOn("Cancel \\(Esc\\)");
      await m.waitVisible("Fetch cancelled — no cards saved.", 7_000);
    }
  },
);
