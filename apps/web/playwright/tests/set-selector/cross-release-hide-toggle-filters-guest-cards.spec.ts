// Origin: .maestro/flows/set-selector/cross-release-hide-toggle-filters-guest-cards.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom, customSport } from "../../support/set-builder";
import { addCustomCard } from "../../support/cards";
import { crossListCards } from "../../support/cross-list";

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
      set: `xsrc-${w}`,
      cardNumber: number,
      playerName: `CrossFilter${env.ATTEMPT_TOKEN}`,
    });
    await drillToCustom(page, {
      sport: customSport(env),
      year: "2026",
      manufacturer: "Topps",
      set: `xcg-${w}`,
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
    await expectAccessible(page, { label: "Checklist with cross-release cards hidden" });

    // Show again: the guest card is restored.
    await page.getByRole("button", { name: "Hide cross-release cards (on)" }).click();
    await expect(guest).toBeVisible();
    await expectAccessible(page, { label: "Checklist with the guest card restored" });

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
