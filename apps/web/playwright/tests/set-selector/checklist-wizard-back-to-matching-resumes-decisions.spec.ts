// Origin: .maestro/flows/set-selector/checklist-wizard-back-to-matching-resumes-decisions.yaml (Maestro suite retired in NEO-341; see git history)
import type { Locator } from "@playwright/test";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { settleMatchCards } from "../../support/pairing";
import { setBuilderReady } from "../../support/set-builder";
import {
  advanceToSave,
  cancelAndDiscard,
  discardResumedReviewBatch,
  fetchChecklistToWizard,
  openDecidedList,
  readBackDecision,
  reviewWizard,
  stepCounter,
  walkToPlayerRow,
} from "../../support/wizard";

test(
  "Entity review — Back to Match Cards leaves the wizard without discarding, and re-confirming comes back to the same review with the decision still on it",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await fetchChecklistToWizard(page, env);
    await discardResumedReviewBatch(page, env);
    const wizard = reviewWizard(page);
    // Nothing decided: on a name step x is the decided count plus one (NEO-335).
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);

    if (!env.SL_PAUSED) {
      // Decide one player, then go back to the pairing step.
      // READY_TO_CREATE: the create below needs a player whose create is not held
      // by a career team the walk skipped.
      await walkToPlayerRow(page, { readyToCreate: true });
      const playerName = ((await wizard.getByRole("heading", { level: 3 }).textContent()) ?? "").trim();
      await wizard.getByRole("button", { name: "Add as New Player" }).click();
      // Read the create back off its own row ("Already decided: Added as new"),
      // never off the "Decided (N)" history: with the reference catalogue loaded
      // this create can be the batch's last name, the wizard has then walked on
      // to "Cards with no team", and the history is not rendered there. The
      // footer Back is "Back to previous decision/step"; the panel's footer
      // still carries "Back to Match Cards", which is pressed next.
      await readBackDecision(page, "Added as new");
      // The history collapses past five decided names, so after the round trip it
      // is opened, then THIS name is found.
      const added = (names: Locator) =>
        names.getByRole("listitem").filter({ hasText: playerName }).filter({ hasText: "Added as new" });
      await expectAccessible(page, { within: wizard, label: "Entity review wizard, player decided" });

      await wizard.getByRole("button", { name: "Back to Match Cards" }).click();
      await expect(wizard).toBeHidden();
      // The parked session comes back already settled; this answers any conflict still open
      // (fetchChecklistToWizard answered them on the way in) and returns the released Confirm.
      const confirmMatches = await settleMatchCards(page, page.getByRole("dialog", { name: /^Match Cards/ }), {
        timeout: 7_000,
      });
      await expectAccessible(page, {
        within: page.getByRole("dialog", { name: /^Match Cards/ }),
        label: "Match Cards dialog after Back to Match Cards",
      });

      // Re-confirming returns to the same review, the decision still on it.
      await confirmMatches.click();
      await expect(wizard).toBeVisible({ timeout: 60_000 });
      // The resumed review opens on a name step (names still undecided) or, when
      // the create was the last name, past the names. The "Decided (N)" history
      // renders on name steps and on Save, never on the teams / titles steps, so
      // in the second shape walk to Save first on the defaults (nothing is saved:
      // the review is discarded below). A Back that had cancelled the batch would
      // reopen on a name step with nothing decided and fail the history assert.
      const nameStepSkip = wizard.getByRole("button", {
        name: /^Skip .* — (not a person|not a team|this team has no league)$/,
      });
      await expect(
        nameStepSkip
          .or(wizard.getByRole("button", { name: "Next (Enter)", exact: true }))
          .or(wizard.getByRole("button", { name: /Confirm & Save/ }))
          .first(),
      ).toBeVisible();
      if (!(await nameStepSkip.first().isVisible())) await advanceToSave(page);
      await expectAccessible(page, { within: wizard, label: "Entity review wizard, resumed with decision" });
      // Open the decided list: the player added as new is still on it.
      await expect(added(await openDecidedList(page))).toBeVisible();

      await cancelAndDiscard(page);
    } else {
      // The solo path has no pairing step to go back to.
      await expect(wizard.getByRole("button", { name: /Cancel \(Esc\)/ })).toBeVisible();
      await expect(wizard.getByRole("button", { name: "Back to Match Cards" })).toBeHidden();
      await wizard.getByRole("button", { name: /Cancel \(Esc\)/ }).click();
      await expect(page.getByText("Fetch cancelled — no cards saved.")).toBeVisible();
    }
  },
);
