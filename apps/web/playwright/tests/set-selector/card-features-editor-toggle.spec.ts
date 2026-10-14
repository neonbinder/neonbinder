// Origin: .maestro/flows/set-selector/card-features-editor-toggle.yaml (Maestro suite retired in NEO-341; see git history)
// The card drawer's Show/Hide features editor toggle round-trips, then the
// card deletes cleanly. Per-worker custom subtree; no marketplace call.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard, confirmDeleteCardButton, deleteCardButton, editCardButton } from "../../support/cards";

test(
  "Regression — Show/Hide features editor toggle expands then collapses the CardFeaturesEditor, then the card deletes cleanly",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const number = `991-${A}`;
    const player = `FeaturesTogglePlayer${env.ATTEMPT_TOKEN}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await addCustomCard(page, env, {
      set: `cft-${env.WORKER_INDEX}`,
      cardNumber: number,
      playerName: player,
    });

    await editCardButton(page, number).click();
    await expect(page.getByRole("textbox", { name: "Card name" })).toBeVisible();

    // Collapsed by default; expand reveals the editor.
    const show = page.getByRole("button", { name: "Show features editor" });
    const editor = page.getByLabel("Card features editor");
    await expect(show).toBeVisible();
    await expect(editor).toBeHidden();
    await show.click();
    await expect(editor).toBeVisible();
    await expectAccessible(page, { within: page.getByRole("dialog"), label: "Card detail drawer with features editor open" });

    // Collapse hides it and the Show button returns.
    await page.getByRole("button", { name: "Hide features editor" }).click();
    await expect(editor).toBeHidden();
    await expect(show).toBeVisible();

    // Close the drawer and delete this attempt's card.
    await page.getByRole("button", { name: "Done editing card" }).click();
    await deleteCardButton(page, number).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await confirmDeleteCardButton(page, number).click();
    await expect(page.getByText(player)).toBeHidden();
  },
);
