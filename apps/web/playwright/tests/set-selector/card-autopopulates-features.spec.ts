// Origin: .maestro/flows/set-selector/card-autopopulates-features.yaml (Maestro suite retired in NEO-341; see git history)
// A freshly created card row carries the inherited physical/production
// defaults from its ancestor chain, read in the card drawer's features editor.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard, confirmDeleteCardButton, deleteCardButton, editCardButton } from "../../support/cards";

test(
  "Write-once feature snapshots — a freshly-created CARD ROW auto-populates its own features with the inherited physical/production defaults from its ancestor chain",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const number = `777-${A}`;
    const player = `AutopopPlayer${env.ATTEMPT_TOKEN}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await addCustomCard(page, env, {
      set: `cap-${env.WORKER_INDEX}`,
      cardNumber: number,
      playerName: player,
    });

    await editCardButton(page, number).click();
    await expect(page.getByRole("textbox", { name: "Card name" })).toBeVisible();
    await page.getByRole("button", { name: "Show features editor" }).click();
    await expect(page.getByLabel("Card features editor")).toBeVisible();

    // Season / country / size / material / thickness / language, all
    // inherited from the ancestors; each control shows its value.
    const defaults: Record<string, string> = {
      Season: "2026",
      "Country of Origin": "USA",
      "Card Size": "Standard",
      Material: "Card Stock",
      "Card Thickness": "20pt",
      Language: "English",
    };
    for (const [feature, value] of Object.entries(defaults)) {
      const field = page.getByLabel(`Value for ${feature}`);
      await expect(field).toBeVisible();
      await expect(field).toHaveValue(value);
    }
    await expectAccessible(page, { within: page.getByRole("dialog"), label: "Card detail drawer with features editor open" });

    await page.getByRole("button", { name: "Done editing card" }).click();
    await deleteCardButton(page, number).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await confirmDeleteCardButton(page, number).click();
    await expect(page.getByText(player)).toBeHidden();
  },
);
