// Origin: .maestro/flows/set-selector/checklist-wizard-back-to-matching-resumes-decisions.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { cancelAndDiscard, discardResumedReviewBatch, fetchChecklistToWizard, reviewWizard, reviewedLine, walkToPlayerRow } from "../../support/wizard";

test(
  "Entity review — Back to matching leaves the wizard without discarding, and re-confirming comes back to the same review with the decision still on it",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await fetchChecklistToWizard(page, env);
    await discardResumedReviewBatch(page, env);
    const wizard = reviewWizard(page);
    await expect(reviewedLine(page)).toHaveText(/^0 of [0-9]+ reviewed/);

    if (!env.SL_PAUSED) {
      // Decide one player, then go back to the pairing step.
      await walkToPlayerRow(page);
      await wizard.getByRole("button", { name: "Add as New Player" }).click();
      await expect(wizard.getByText("Added as new").first()).toBeVisible();
      const decided = wizard.getByText(/^Decided \([0-9]+\)$/);
      await expect(decided).toBeVisible();
      const decidedBefore = (await decided.textContent()) ?? "";
      await expectAccessible(page, { within: wizard, label: "Entity review wizard, player decided" });

      await wizard.getByRole("button", { name: "Back to matching" }).click();
      await expect(wizard).toBeHidden();
      const confirmMatches = page.getByRole("button", { name: "Confirm card matches", disabled: false });
      await expect(confirmMatches).toBeVisible();
      await expectAccessible(page, {
        within: page.getByRole("dialog", { name: /^Match Cards/ }),
        label: "Match Cards dialog after Back to matching",
      });

      // Re-confirming returns to the same review, the decision still on it.
      await confirmMatches.click();
      await expect(wizard).toBeVisible({ timeout: 60_000 });
      await expect(decided).toHaveText(decidedBefore);
      await expectAccessible(page, { within: wizard, label: "Entity review wizard, resumed with decision" });
      // Open the decided list: the player added as new is still on it.
      await decided.click();
      await expect(wizard.getByText("Added as new").first()).toBeVisible();

      await cancelAndDiscard(page);
    } else {
      // The solo path has no pairing step to go back to.
      await expect(wizard.getByRole("button", { name: /Cancel \(Esc\)/ })).toBeVisible();
      await expect(wizard.getByRole("button", { name: "Back to matching" })).toBeHidden();
      await wizard.getByRole("button", { name: /Cancel \(Esc\)/ }).click();
      await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible();
    }
  },
);
