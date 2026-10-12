// Origin: .maestro/flows/set-selector/team-picker-create-custom-card.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { addCustomCard } from "../../support/cards";

test(
  "Team picker — create a brand-new team via the New Team dialog and attach it to a card; it persists across reopen",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const num = `776-${env.ATTEMPT_ID}`;
    const player = `Team Create Card ${env.ATTEMPT_ID}`;
    const team = `NBTeam${env.ATTEMPT_TOKEN}`;
    const edit = page.getByRole("button", { name: new RegExp(`^Edit card ${num}(, .*)?$`) });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await addCustomCard(page, env, {
      set: `tpc-${env.WORKER_INDEX}`,
      cardNumber: num,
      playerName: player,
    });

    await edit.click();
    await expect(page.getByRole("textbox", { name: "Card name" })).toBeVisible();

    // The picker offers a brand-new name as "New team", which opens the dialog.
    await expect(page.getByLabel("Team picker")).toBeVisible();
    await page.getByRole("button", { name: "Add team" }).click();
    await page.getByRole("textbox", { name: "Search teams" }).fill(team);
    await page.getByRole("button", { name: `New team ${team}` }).click();

    const dialog = page.getByRole("dialog", { name: `New team: ${team}` });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "New team name" })).toHaveValue(team);
    await dialog.getByRole("button", { name: `Create team ${team}` }).click();

    await expect(page.getByRole("button", { name: `Remove team ${team}` })).toBeVisible();
    await expect(page.getByText(/Saved Teams/)).toBeVisible();

    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(page.getByRole("textbox", { name: "Card name" })).toBeHidden();

    // Reopen: the team persisted on the card.
    await edit.click();
    await expect(page.getByRole("textbox", { name: "Card name" })).toBeVisible();
    await expect(page.getByRole("button", { name: `Remove team ${team}` })).toBeVisible();

    await page.getByRole("button", { name: "Done editing card" }).click();
    await expect(page.getByRole("textbox", { name: "Card name" })).toBeHidden();

    await page.getByRole("button", { name: new RegExp(`^Delete card ${num}(, .*)?$`) }).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^Confirm delete card ${num}(, .*)?$`) }).click();
    await expect(page.getByText(player)).toBeHidden();
  },
);
