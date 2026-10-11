// Spec: .maestro/flows/set-selector/checklist-wizard-link-to-existing-player.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import {
  cancelAndDiscard,
  discardResumedReviewBatch,
  fetchChecklistToWizard,
  reviewWizard,
  walkToPlayerRow,
} from "../../support/batch3/wizard";

test(
  "Entity review — Link to Existing resolves an unknown name onto a player we already have instead of minting a duplicate",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await fetchChecklistToWizard(page, env);
    await discardResumedReviewBatch(page, env);

    // Past the team steps, to the first player row.
    await walkToPlayerRow(page);
    const wizard = reviewWizard(page);

    // Link the unknown name to a player we already have.
    await wizard.getByRole("button", { name: "Link to existing instead" }).click({ timeout: 30_000 });
    await wizard.getByRole("textbox", { name: "Search existing players" }).fill("Ohtani");
    await wizard.getByRole("option", { name: "Link to Shohei Ohtani" }).click();
    await expect(wizard.getByText("Linked to Shohei Ohtani")).toBeVisible();

    await cancelAndDiscard(page);
  },
);
