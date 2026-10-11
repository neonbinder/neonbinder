// Port of .maestro/flows/set-selector/checklist-wizard-link-to-existing-player.yaml
import { test } from "../../support/fixtures";
import { utilFetchRealSetChecklistToWizard } from "../../support/subflows/set-selector/util-fetch-real-set-checklist-to-wizard";
import { utilDiscardResumedReviewBatch } from "../../support/subflows/set-selector/util-discard-resumed-review-batch";
import { utilWizardWalkToPlayerRow } from "../../support/subflows/set-selector/util-wizard-walk-to-player-row";

test(
  "Entity review — Link to Existing resolves an unknown name onto a player we already have instead of minting a duplicate",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilFetchRealSetChecklistToWizard(m);
    await utilDiscardResumedReviewBatch(m);
    await m.assertVisible("0 of [0-9]+ reviewed.*");
    await utilWizardWalkToPlayerRow(m);
    await m.waitVisible(m.id("Link to existing instead"), 30_000);
    await m.retry(2, async () => {
      await m.tapOn(m.id("Link to existing instead"));
      await m.waitVisible(m.id("Search existing players"), 10_000);
    });
    await m.tapOn(m.id("Search existing players"));
    await m.inputText("Ohtani");
    await m.waitVisible(m.id("Link to Shohei Ohtani"));
    await m.tapOn(m.id("Link to Shohei Ohtani"));
    await m.waitVisible("Linked to Shohei Ohtani");
    // Maestro `text: "Cancel (Esc)"` reads as a regex group; escaped here so the full-match hits the literal button text.
    await m.tapOn("Cancel \\(Esc\\)");
    await m.assertVisible("Discard [0-9]+ decisions?.*");
    await m.tapOn("Discard");
    await m.waitVisible("Fetch cancelled — no cards saved.");
  },
);
