// Spec: .maestro/flows/set-selector/card-features-editor-toggle.yaml
// The card drawer's Show/Hide features editor toggle round-trips, then the
// card deletes cleanly. Per-worker custom subtree; no marketplace call.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard } from "../../support/batch6/custom";

test(
  "Regression — Show/Hide features editor toggle expands then collapses the CardFeaturesEditor, then the card deletes cleanly",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const number = `991-${A}`;
    const player = `Features Toggle Player ${A}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await addCustomCard(page, env, {
      setName: `cft-${env.WORKER_INDEX}`,
      cardNumber: number,
      playerName: player,
    });

    await page.getByRole("button", { name: `Edit card ${number}` }).click();
    await expect(page.getByRole("textbox", { name: "Card name" })).toBeVisible();

    // Collapsed by default; expand reveals the editor.
    const show = page.getByRole("button", { name: "Show features editor" });
    const editor = page.getByLabel("Card features editor");
    await expect(show).toBeVisible();
    await expect(editor).toBeHidden();
    await show.click();
    await expect(editor).toBeVisible();

    // Collapse hides it and the Show button returns.
    await page.getByRole("button", { name: "Hide features editor" }).click();
    await expect(editor).toBeHidden();
    await expect(show).toBeVisible();

    // Close the drawer and delete this attempt's card.
    await page.getByRole("button", { name: "Done editing card" }).click();
    await page.getByRole("button", { name: `Delete card ${number}` }).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await page.getByRole("button", { name: `Confirm delete card ${number}` }).click();
    await expect(page.getByText(player)).toBeHidden();
  },
);
