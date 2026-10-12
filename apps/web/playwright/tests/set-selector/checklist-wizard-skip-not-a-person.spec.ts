// Origin: .maestro/flows/set-selector/checklist-wizard-skip-not-a-person.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import {
  cancelAndDiscard,
  fetchOneMarketplaceSetChecklistToWizard,
  personSkip,
  reviewedLine,
  reviewWizard,
  walkToPlayerRow,
} from "../../support/wizard";

// Sole reader of the 1995 Fort Worth Fire CHL set (SET-REGISTRY.md), BSC only.
// Approved by Jason 2026-10-10 (NEO-330), moving off the shared Topps Big
// League set: with the reference catalogue loaded Big League stages too few
// names to leave one for the footer skip after the per-row one. MEASURED on
// PR #314's preview: 18 cards, 16 unknown names, all players, 0 teams.
// Read-only (R7): it exits through Cancel -> Discard, which saves no card,
// writes no skip record and mints nothing, so the set stays first-fetch.
const SET = "Fort Worth Fire CHL";

test(
  "Entity review — Skip marks a name as not a person, and the footer skip decides every row that is left, lookups included",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await fetchOneMarketplaceSetChecklistToWizard(page, env, { set: SET });
    const wizard = reviewWizard(page);
    // Nothing else touches this set, so there is no sibling batch to resume.
    await expect(reviewedLine(page)).toHaveText(/^0 of [0-9]+ reviewed/);

    // Reach a settled player row. Every step the walk answers is a SKIP, so
    // every decision in this batch is one, which the summary reads back below.
    await walkToPlayerRow(page);
    await expect(personSkip(page)).toBeVisible({ timeout: 30_000 });
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, player row" });

    // One tap records exactly ONE decision: the header's "K of N reviewed"
    // moves by one and N does not. (K is wherever the walk left it; a control
    // that rendered but wrote nothing leaves it where it was.)
    const [, decidedBefore, total] = ((await reviewedLine(page).textContent()) ?? "").match(/^([0-9]+) of ([0-9]+)/) ?? [];
    expect(total, "the header shows a K of N reviewed count").toBeTruthy();
    await personSkip(page).click();
    // Our own mutation answering: a UX budget (R5).
    await expect(reviewedLine(page)).toHaveText(new RegExp(`^${Number(decidedBefore) + 1} of ${total} reviewed`));
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, name skipped" });

    // The footer skip decides every row that is left, lookups included.
    const skipRemaining = wizard.getByRole("button", { name: /Skip remaining names \([0-9]+\)/ });
    await skipRemaining.click();
    await expect(wizard.getByRole("button", { name: /Confirm & Save/ })).toBeVisible({ timeout: 120_000 });
    await expect(skipRemaining).toBeHidden();
    // ...and every decision is a SKIP, the per-row one included: the all-decided
    // summary lists only non-zero outcomes, so "Skipped as not a name" present
    // with "New players and teams" and "Linked to existing" absent means
    // nothing was created or linked. With the exactly-one-decision check above,
    // the per-row tap's decision was a skip.
    await expect(wizard.getByText("Skipped as not a name", { exact: true })).toBeVisible();
    await expect(wizard.getByText("New players and teams", { exact: true })).toBeHidden();
    await expect(wizard.getByText("Linked to existing", { exact: true })).toBeHidden();
    await expectAccessible(page, { within: wizard, label: "Entity review wizard, summary" });

    await cancelAndDiscard(page);
  },
);
