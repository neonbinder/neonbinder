// Origin: .maestro/flows/set-selector/checklist-wizard-skip-commits-and-unskip.yaml (Maestro suite retired in NEO-341; see git history)
// Skipping every name and committing leaves the set its own "Skipped names"
// list; Unskip puts a name back for the next sync.
//
// Sole writer of the 1995 Tulsa Oilers CHL set (SET-REGISTRY.md), BSC only;
// fresh-only (a committed set re-syncs, and a re-sync raises no review).
// Approved by Jason 2026-10-10 (NEO-330), replacing Topps Chicago Cubs: the
// reference catalogue knows every Cubs player, so that fetch committed straight
// through with no wizard. MEASURED on PR #314's preview: 18 cards, 16 unknown
// names, all players, 0 teams; once the lookups settle the batch holds 19 rows
// (three players' career clubs are staged as their own steps), and the bulk
// skip decides those too. One of the 16 is a same-name row ("Taylor Hall", two
// Hockey players on file), inserted READY as a pick step; the bulk skip decides
// every undecided row, pick steps included. Every decision is a skip, so no
// player is minted. Re-seed before re-running.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import {
  advanceToSave,
  confirmSaveButton,
  fetchOneMarketplaceSetChecklistToWizard,
  reviewWizard,
  stepCounter,
} from "../../support/wizard";

test(
  "Entity review — committing a review of skips leaves the set its own Skipped names list, and Unskip puts a name back",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await fetchOneMarketplaceSetChecklistToWizard(page, env, { set: "Tulsa Oilers CHL" });

    const wizard = reviewWizard(page);
    // Nothing decided: "Step 1 of N" (on a name step x is the decided count plus one).
    await expect(stepCounter(page)).toHaveText(/^Step 1 of [0-9]+$/);

    // Skip every remaining name; the wizard leaves its name steps (the footer
    // shows "Next (Enter)" on a teams / titles step, else "Confirm & Save").
    await wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ }).click();
    const confirmSave = confirmSaveButton(page);
    await expect(
      wizard.getByRole("button", { name: "Next (Enter)", exact: true }).or(confirmSave),
    ).toBeVisible({ timeout: 120_000 });
    // NEO-335: past the names the wizard may ask about teamless cards and card
    // titles before it saves; this spec's feature is the skips, so those stay
    // on their defaults and the walk goes on to the Save step.
    await advanceToSave(page);
    // Only the Save step is reachable once every row is decided, and its heading lives only there.
    await expect(wizard.getByText(/Save [0-9]+ cards?\?/)).toBeVisible();
    // The summary counts the names skipped as not-a-name, and nothing was added.
    // The summary lists only non-zero outcomes: "Skipped as not a name" present
    // with "New players and teams" and "Linked to existing" absent means no row
    // was created or linked (the assertion that catches a mis-landed bulk-add).
    await expect(wizard.getByText("Skipped as not a name", { exact: true })).toBeVisible();
    await expect(wizard.getByText("New players and teams", { exact: true })).toBeHidden();
    await expect(wizard.getByText("Linked to existing", { exact: true })).toBeHidden();
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
