// Spec: .maestro/flows/set-selector/cross-release-hide-toggle-filters-guest-cards.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard, drillToCustom, customSport } from "../../support/batch4/custom-drill";
import { crossListCards } from "../../support/batch4/cross-list";

test(
  "Cross-release — the 'Hide cross-release cards' filter collapses a checklist back to only its own cards, and restores them",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const w = env.WORKER_INDEX;
    const number = `955-${env.ATTEMPT_ID}`;
    const guest = page.getByText(`#${number}`);

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // The home set owns the card; a second, empty set borrows it.
    await addCustomCard(page, env, {
      setName: `xsrc-${w}`,
      cardNumber: number,
      playerName: `Cross Filter ${env.ATTEMPT_ID}`,
    });
    await drillToCustom(page, {
      sport: customSport(env),
      year: "2026",
      manufacturer: "Topps",
      setName: `xcg-${w}`,
      variantType: "Insert",
      variant: "Base",
    });
    await crossListCards(page, env, { set: `xsrc-${w}` }, number);
    await expect(page.getByText(/Linked 1 card/)).toBeVisible();
    await page.getByRole("button", { name: "Cancel cross-release import" }).click();
    await expect(page.getByRole("dialog", { name: "Add cross-release cards" })).toBeHidden();
    await expect(guest).toBeVisible();

    // Hide: back to only this set's own cards (none).
    await page.getByRole("button", { name: "Hide cross-release cards", exact: true }).click();
    await expect(guest).toBeHidden();
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();

    // Show again: the guest card is restored.
    await page.getByRole("button", { name: "Hide cross-release cards (on)" }).click();
    await expect(guest).toBeVisible();

    // Unlink it so the set ends empty for the next run.
    await page
      .getByRole("button", { name: new RegExp(`^Remove card ${number}(, .*)? from this set$`) })
      .click();
    await page
      .getByRole("button", { name: new RegExp(`^Confirm remove card ${number}(, .*)? from this set$`) })
      .click();
    await expect(guest).toBeHidden();
  },
);
