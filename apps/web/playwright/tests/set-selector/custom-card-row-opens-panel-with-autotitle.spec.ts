// Origin: .maestro/flows/set-selector/custom-card-row-opens-panel-with-autotitle.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard } from "../../support/cards";

test(
  "Card row — clicking the card NUMBER (not the name or Edit button) opens the detail panel, which shows an auto-generated Card title",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const num = `779-${env.ATTEMPT_ID}`;
    const player = `RowClickPlayer${env.ATTEMPT_TOKEN}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await addCustomCard(page, env, {
      set: `clt-${env.WORKER_INDEX}`,
      cardNumber: num,
      playerName: player,
    });

    // The card-number cell is neither the name text nor Edit/Delete; the whole row opens the panel.
    await page.getByText(`#${num}`, { exact: true }).click();

    // The panel is THIS card's, and its auto-generated listing title carries the number.
    await expect(page.getByRole("textbox", { name: "Card name" })).toBeVisible();
    await expect(page.getByText(new RegExp(`Card #${num}`))).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Card title" })).toHaveValue(new RegExp(`#${num}`));
    await expectAccessible(page, { within: page.getByRole("dialog"), label: "Card detail drawer opened from the row" });

    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(page.getByRole("textbox", { name: "Card name" })).toBeHidden();

    // Cleanup: delete the card through its two-step control.
    await page.getByRole("button", { name: new RegExp(`^Delete card ${num}(, .*)?$`) }).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^Confirm delete card ${num}(, .*)?$`) }).click();
    await expect(page.getByText(player)).toBeHidden();
  },
);
