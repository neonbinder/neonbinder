// Origin: .maestro/flows/set-selector/checklist-wizard-skip-commits-and-unskip.yaml (Maestro suite retired in NEO-341; see git history)
// Skipping every name and committing leaves the set its own "Skipped names"
// list; Unskip puts a name back for the next sync.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { fetchChecklistToWizard } from "../../support/wizard";

test(
  "Entity review — committing a review of skips leaves the set its own Skipped names list, and Unskip puts a name back",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await fetchChecklistToWizard(page, env, { set: "Topps Chicago Cubs" });

    const wizard = page.getByRole("dialog", { name: "Confirm New Players & Teams" });
    await expect(wizard.getByText(/^0 of [0-9]+ reviewed/)).toBeVisible();

    // Skip every remaining name; the wizard reaches its summary.
    await wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ }).click();
    const confirmSave = wizard.getByRole("button", { name: /Confirm & Save/ });
    await expect(confirmSave).toBeVisible({ timeout: 120_000 });
    await expect(wizard.getByText(/All reviewed . save [0-9]+ cards\?/)).toBeVisible();
    // The summary counts the names skipped as not-a-name, and nothing was added.
    await expect(wizard.getByText("Skipped as not a name")).toBeVisible();
    await expect(wizard.getByText("Added as new")).toBeHidden();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, summary" });

    await confirmSave.click();
    await expect(page.getByText(/Saved [0-9]+ cards/)).toBeVisible({ timeout: 60_000 });
    await expect(wizard).toBeHidden();

    // The set now keeps its own Skipped names list.
    const skipped = page.getByText(/^Skipped names \([0-9]+\)$/);
    await skipped.click();
    await expect(page.getByText(/Unskip a name to review it on the next sync/)).toBeVisible();
    await expectAccessible(page, { label: "Skipped names panel" });

    await page.getByRole("button", { name: /^Unskip / }).first().click();
    await expect(page.getByText(/Unskipped .* it will be reviewed on the next sync\./)).toBeVisible();
  },
);
