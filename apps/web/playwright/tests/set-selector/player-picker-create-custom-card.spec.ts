// Origin: .maestro/flows/set-selector/player-picker-create-custom-card.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard } from "../../support/cards";

test(
  "Player picker — create a brand-new player and attach it to a CUSTOM card (the gap this closes); it persists across reopen",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const id = env.ATTEMPT_ID;
    const cardNumber = `777-${id}`;
    const player = `NBPlayer${env.ATTEMPT_TOKEN}`;
    const editCard = page.getByRole("button", { name: new RegExp(`^Edit card ${cardNumber}(, .*)?$`) });
    const deleteCard = page.getByRole("button", { name: new RegExp(`^Delete card ${cardNumber}(, .*)?$`) });
    const confirmDelete = page.getByRole("button", {
      name: new RegExp(`^Confirm delete card ${cardNumber}(, .*)?$`),
    });
    const cardName = page.getByRole("textbox", { name: "Card name", exact: true });
    const done = page.getByRole("button", { name: "Done editing card" });
    const attached = page.getByRole("button", { name: `Remove player ${player}` });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await addCustomCard(page, env, {
      set: `pp-${env.WORKER_INDEX}`,
      cardNumber,
      playerName: `Player Picker Card ${id}`,
    });

    await editCard.click();
    await expect(cardName).toBeVisible({ timeout: 15_000 });

    // The drawer's player picker: add a player that does not exist yet.
    await expect(page.getByLabel("Player picker", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add player" }).click();
    await page.getByRole("textbox", { name: "Search players" }).fill(player);
    await page.getByRole("option", { name: `Create player ${player}` }).click();
    await expect(attached).toBeVisible();
    await expect(page.getByText(/Saved Players/)).toBeVisible();

    await done.click();
    await expect(cardName).toBeHidden();

    // Reopen: the new player persisted on the card.
    await editCard.click();
    await expect(cardName).toBeVisible({ timeout: 15_000 });
    await expect(attached).toBeVisible();
    await done.click();
    await expect(cardName).toBeHidden();

    await deleteCard.click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await confirmDelete.click();
    await expect(page.getByText(`Player Picker Card ${id}`)).toBeHidden();
  },
);
