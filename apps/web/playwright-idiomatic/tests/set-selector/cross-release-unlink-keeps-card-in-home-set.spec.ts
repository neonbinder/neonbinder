// Spec: .maestro/flows/set-selector/cross-release-unlink-keeps-card-in-home-set.yaml
// Detaching a visiting card is a REMOVAL, not a DELETION: the row's button
// says "Unlink", asks to confirm, empties the guest checklist (and the
// "Hide cross-release cards" control with it), and the card is still intact
// in the set it was printed in. Per-worker custom subtree; no marketplace.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard, drillToCustomSet } from "../../support/batch6/custom";
import { crossListCards } from "../../support/batch4/cross-list";

test(
  "Cross-release — 'Unlink' removes a visiting card from this checklist without deleting it from the set it was printed in",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const number = `957-${A}`;
    const player = `Cross Unlink ${A}`;
    const home = `xds-${env.WORKER_INDEX}`;
    const guest = `xdg-${env.WORKER_INDEX}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // The card, in its home set.
    await addCustomCard(page, env, { setName: home, cardNumber: number, playerName: player });

    // The guest checklist borrows it.
    await drillToCustomSet(page, env, { setName: guest, variant: "Base" });
    await crossListCards(page, env, { set: home }, number);
    await page.getByRole("button", { name: "Cancel cross-release import" }).click();
    await expect(page.getByRole("dialog", { name: "Add cross-release cards" })).toBeHidden();

    // The visiting row exists: the precondition for the unlink.
    await expect(page.getByText(`#${number}`, { exact: true })).toBeVisible();

    // 1. The destructive button says "Unlink", not "Del".
    const unlink = page.getByRole("button", { name: new RegExp(`^Remove card ${number}(,.*)? from this set$`) });
    await expect(unlink).toHaveText("Unlink");
    // 2. It asks before doing anything.
    await unlink.click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await page
      .getByRole("button", { name: new RegExp(`^Confirm remove card ${number}(,.*)? from this set$`) })
      .click();

    // 3. The visiting card has left this checklist, which falls back to its empty message.
    await expect(page.getByText(`#${number}`, { exact: true })).toBeHidden();
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
    // 4. The guest appearance is severed, not just hidden: the control that
    // only exists while a visiting card is held is gone.
    await expect(page.getByRole("button", { name: "Hide cross-release cards" })).toBeHidden();

    // 5. THE POINT: reopen the home set; the card is still there, intact.
    await drillToCustomSet(page, env, { setName: home, variant: "Base" });
    await expect(page.getByText(`#${number}`, { exact: true })).toBeVisible();
    await expect(page.getByText(player, { exact: true })).toBeVisible();

    // Cleanup: an ordinary delete of this attempt's card in its own home set.
    await page.getByRole("button", { name: `Delete card ${number}` }).click();
    await page.getByRole("button", { name: `Confirm delete card ${number}` }).click();
    await expect(page.getByText(`#${number}`, { exact: true })).toBeHidden();
  },
);
