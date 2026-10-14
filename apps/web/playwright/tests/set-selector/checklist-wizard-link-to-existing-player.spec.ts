// Origin: .maestro/flows/set-selector/checklist-wizard-link-to-existing-player.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { cancelAndDiscard, discardResumedReviewBatch, fetchChecklistToWizard, readBackDecision, reviewWizard, stepCounter, walkToPlayerRow } from "../../support/wizard";

test(
  "Entity review — Link to Existing resolves an unknown name onto a player we already have instead of minting a duplicate",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await fetchChecklistToWizard(page, env);
    await discardResumedReviewBatch(page, env);
    // Nothing decided: on a name step x is the decided count plus one (NEO-335).
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);

    // Past the team steps, to the first player row.
    await walkToPlayerRow(page);
    const wizard = reviewWizard(page);
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, player row" });

    // Link the unknown name to a player we already have.
    await wizard.getByRole("button", { name: "Link to existing instead" }).click({ timeout: 30_000 });
    await wizard.getByRole("textbox", { name: "Search existing players" }).fill("Ohtani");
    const linkOption = wizard.getByRole("option", { name: "Link to Shohei Ohtani" });
    await expect(linkOption).toBeVisible();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, link search results" });
    await linkOption.click();
    // Read back off the row the link was made on (its "Already decided:" panel),
    // never off the "Decided (N)" history: batch-ordered and collapsed past five,
    // it showed this line only while the walk landed on one of the batch's first
    // rows. No resume: the spec leaves through Cancel next.
    await readBackDecision(page, "Linked to Shohei Ohtani");
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, linked player" });

    await cancelAndDiscard(page);
  },
);
