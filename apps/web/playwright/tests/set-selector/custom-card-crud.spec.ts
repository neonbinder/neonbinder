// Origin: .maestro/flows/set-selector/custom-card-crud.yaml (Maestro suite retired in NEO-341; see git history)
// A hand-added card in the worker's own custom subtree: add, rename (Enter
// commits in place), delete (two-step). No marketplace call fires.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard, confirmDeleteCardButton, deleteCardButton, editCardButton } from "../../support/cards";

test(
  "Custom card lifecycle — add a card by hand, rename it, delete it",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const number = `999-${A}`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await addCustomCard(page, env, {
      set: `ccrud-${env.WORKER_INDEX}`,
      cardNumber: number,
      playerName: `Test Player ${A}`,
      cardName: `CRUDName-${A}`,
    });

    // The new row: number, card name and its edit control.
    await expect(page.getByText(`#${number}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`CRUDName-${A}`, { exact: true })).toBeVisible();
    await expectAccessible(page, { label: "Checklist with a hand-added card" });
    await editCardButton(page, number).click();

    // Rename: a single-line field commits on Enter, and the drawer confirms it.
    const cardName = page.getByRole("textbox", { name: "Card name" });
    await expect(cardName).toBeVisible();
    await expectAccessible(page, { within: page.getByRole("dialog"), label: "Card detail drawer" });
    await cardName.fill(`Renamed-${A}`);
    await cardName.press("Enter");
    await expect(page.getByText(/Saved Card name/)).toBeVisible();
    await page.getByRole("button", { name: "Done editing card" }).click();

    await expect(page.getByText(`Renamed-${A}`, { exact: true })).toBeVisible();
    await expect(page.getByText(`CRUDName-${A}`)).toBeHidden();

    // Delete is two-step: Del, then Confirm.
    await deleteCardButton(page, number).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await confirmDeleteCardButton(page, number).click();
    await expect(page.getByText(`Renamed-${A}`)).toBeHidden();
  },
);
