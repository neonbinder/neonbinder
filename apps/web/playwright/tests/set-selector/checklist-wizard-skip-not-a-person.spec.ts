// Port of .maestro/flows/set-selector/checklist-wizard-skip-not-a-person.yaml
import { test } from "../../support/fixtures";
import { utilFetchRealSetChecklistToWizard } from "../../support/subflows/set-selector/util-fetch-real-set-checklist-to-wizard";
import { utilDiscardResumedReviewBatch } from "../../support/subflows/set-selector/util-discard-resumed-review-batch";
import { utilWizardWalkToPlayerRowCreatingTeams } from "../../support/subflows/set-selector/util-wizard-walk-to-player-row-creating-teams";

test(
  "Entity review — Skip marks a name as not a person, and the footer skip decides every row that is left, lookups included",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilFetchRealSetChecklistToWizard(m);
    await utilDiscardResumedReviewBatch(m);
    await m.assertVisible("0 of [0-9]+ reviewed.*");

    await utilWizardWalkToPlayerRowCreatingTeams(m);
    await m.waitVisible(m.id("Skip .* not a (person|team)"), 30_000);
    await m.assertVisible("Skip . not a (person|team)");

    await m.tapOn(m.id("Skip .* not a (person|team)"));
    await m.waitVisible("Skipped");
    await m.assertVisible("Decided \\([0-9]+\\)");

    await m.tapOn(".*Skip remaining names \\([0-9]+\\).*");
    await m.waitVisible(".*Confirm & Save.*", 120_000);
    await m.assertNotVisible(".*Skip remaining names \\([0-9]+\\).*");

    // "Cancel (Esc)" is a literal label; parentheses escaped for the regex-only driver.
    await m.tapOn("Cancel \\(Esc\\)"); // retryTapIfNoChange dropped
    await m.assertVisible("Discard [0-9]+ decisions.*");
    await m.tapOn("Discard");
    await m.waitVisible("Fetch cancelled — no cards saved.");
  },
);
