// Port of .maestro/flows/set-selector/checklist-wizard-skip-commits-and-unskip.yaml
import { test } from "../../support/fixtures";
import { utilFetchRealSetChecklistToWizard } from "../../support/subflows/set-selector/util-fetch-real-set-checklist-to-wizard";

test(
  "Entity review — committing a review of skips leaves the set its own Skipped names list, and Unskip puts a name back",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilFetchRealSetChecklistToWizard(m, { SET: "Topps Chicago Cubs" });

    // STEP 1
    await m.assertVisible("0 of [0-9]+ reviewed.*");

    // STEP 2 — decide the whole review from the footer
    await m.tapOn(".*Skip remaining names \\([0-9]+\\).*");
    await m.waitVisible(".*Confirm & Save.*", 120_000);
    await m.assertVisible("All reviewed . save [0-9]+ cards\\?");
    await m.assertVisible("Skipped");
    await m.assertNotVisible("Added as new");

    // STEP 4 — commit
    await m.tapOn(".*Confirm & Save.*");
    await m.waitVisible(".*Saved [0-9]+ cards.*", 60_000);

    // STEP 5 — the set now remembers what was skipped
    await m.scrollUntilVisible(m.id("Skipped names \\([0-9]+\\) . not players or teams"), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id("Skipped names \\([0-9]+\\) . not players or teams"));
    await m.assertVisible(".*Unskip a name to review it on the next sync.*");

    // STEP 6 — the skip is reversible
    await m.scrollUntilVisible(m.id("Unskip .*"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Unskip .*"));
    await m.scrollUntilVisible("Unskipped .* it will be reviewed on the next sync.", {
      centerElement: true,
      timeout: 7_000,
    });
  },
);
