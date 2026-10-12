// Origin: .maestro/flows/set-selector/checklist-wizard-skip-not-a-person.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { cancelAndDiscard, discardResumedReviewBatch, fetchChecklistToWizard, personSkip, reviewWizard, walkToPlayerRow } from "../../support/wizard";

test(
  "Entity review — Skip marks a name as not a person, and the footer skip decides every row that is left, lookups included",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await fetchChecklistToWizard(page, env);
    await discardResumedReviewBatch(page, env);

    // Reach a settled player row, creating the team/league steps on the way.
    await walkToPlayerRow(page, { creatingTeams: true });
    const wizard = reviewWizard(page);
    await expect(personSkip(page)).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, player row" });

    // Skipping marks the name "not a person" and records a decision.
    await personSkip(page).click();
    await expect(wizard.getByText("Skipped").first()).toBeVisible();
    await expect(wizard.getByText(/Decided \([0-9]+\)/)).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, name skipped" });

    // The footer skip decides every row that is left, lookups included.
    const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
    await skipRemaining.click();
    await expect(wizard.getByRole("button", { name: /Confirm & Save/ })).toBeVisible({ timeout: 120_000 });
    await expect(skipRemaining).toBeHidden();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, summary" });

    await cancelAndDiscard(page);
  },
);
