// Spec: .maestro/flows/set-selector/card-autopopulates-features.yaml
// A freshly created card row carries the inherited physical/production
// defaults from its ancestor chain, read in the card drawer's features editor.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard } from "../../support/batch6/custom";

test(
  "Write-once feature snapshots — a freshly-created CARD ROW auto-populates its own features with the inherited physical/production defaults from its ancestor chain",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const number = `777-${A}`;
    const player = `Autopop Card Player ${A}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await addCustomCard(page, env, {
      setName: `cap-${env.WORKER_INDEX}`,
      cardNumber: number,
      playerName: player,
    });

    await page.getByRole("button", { name: `Edit card ${number}` }).click();
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

    await page.getByRole("button", { name: "Done editing card" }).click();
    await page.getByRole("button", { name: `Delete card ${number}` }).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await page.getByRole("button", { name: `Confirm delete card ${number}` }).click();
    await expect(page.getByText(player)).toBeHidden();
  },
);
