// Origin: .maestro/flows/set-selector/card-player-picker-cross-sport.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-313: switch the quick-add player search to Football and put a football
// player on a baseball card; the card carries him with his sport, and he stays
// out of Baseball's roster on /admin/players.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { addPlayerByHand } from "../../support/players";
import { confirmDeleteCardButton, deleteCardButton, editCardButton, openVariant } from "../../support/cards";
import { drillToCustom } from "../../support/set-builder";

test(
  "Card player picker — switch the search to Football and put a football player on a baseball card; the card carries him with his sport, and he stays out of Baseball's roster (NEO-313)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const PLAYER = `Gp${env.ATTEMPT_TOKEN}`;
    const card = `315-${A}`;
    const target = {
      sport: "Baseball",
      year: "2024",
      manufacturer: "Topps",
      set: `xsp-${env.WORKER_INDEX}`,
      variantType: "Insert",
    };

    await signIn("/admin/players");
    await expect(page.getByText(/of .* players/)).toBeVisible({ timeout: LAUNCH_GATE });

    // A football player, made by hand.
    await addPlayerByHand(page, PLAYER, "Football");

    // A baseball set with a quick-add card form.
    await drillToCustom(page, target);
    await openVariant(page, "Insert", "Base");
    await page.getByRole("button", { name: "Open add card form" }).click();
    await page.getByRole("textbox", { name: "Card number" }).fill(card);
    await page.getByRole("textbox", { name: "Card name" }).fill(`Guest Card ${A}`);

    // Search for him: the picker searches Baseball until the sport is switched.
    // The results popover opens below the field and is fixed to the viewport,
    // so a user lifts the form to mid-screen first (the 1024x629 viewport would
    // otherwise leave the sport switch below the fold).
    await page.getByRole("heading", { name: "Add Card" }).hover();
    await page.mouse.wheel(0, 250);
    await page.getByRole("button", { name: "Add a player to the new card" }).click();
    await page.getByRole("textbox", { name: "Find a player for the new card" }).fill(PLAYER);
    await expect(page.getByRole("option", { name: `Create player ${PLAYER}` })).toBeVisible();
    await page.getByRole("button", { name: "Sport to search for players: Baseball" }).click();
    const chooser = page.getByLabel("Choose a sport", { exact: true });
    await expect(chooser).toBeVisible();
    await page.keyboard.type("F");
    await chooser.getByText("Football", { exact: true }).click();
    await expect(page.getByRole("button", { name: "Sport to search for players: Football" })).toBeVisible();

    // He now shows up; add him. The chip carries his sport.
    await page.getByRole("option", { name: `Add ${PLAYER}` }).click();
    await expect(page.getByRole("button", { name: `Remove player ${PLAYER}` })).toBeVisible();
    await expect(page.getByLabel("Players on the new card", { exact: true }).getByText("Football")).toBeVisible();

    await page.getByRole("textbox", { name: "Card name" }).click();
    await expect(page.getByRole("textbox", { name: "Find a player for the new card" })).toBeHidden();
    await page.getByRole("button", { name: "Submit new card" }).click();
    await expect(page.getByRole("textbox", { name: "Card number" })).toBeHidden();

    // On /admin/players he is a Football player, not on Baseball's roster.
    await page.goto("/admin/players");
    await expect(page.getByText(/of .* players/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole("textbox", { name: "Filter players" }).fill(PLAYER);
    await expect(page.getByText(/matches/).first()).toBeVisible();
    const sport = page.getByRole("combobox", { name: "Sport" });
    await sport.selectOption("Baseball");
    await expect(page.getByText("No players match that filter.")).toBeVisible();
    await expect(page.getByText("0 matches", { exact: true })).toBeVisible();
    await sport.selectOption("Football");
    const row = page.getByRole("button", { name: new RegExp(PLAYER) });
    await row.first().click();
    const cards = page.getByLabel(`Cards for ${PLAYER}`, { exact: true });
    await expect(cards).toBeVisible();
    await expect(cards.getByText(`#${card}`)).toBeVisible();
    await expect(cards.getByText("Baseball")).toBeVisible();

    // The card carries him, with his sport, in its drawer.
    await drillToCustom(page, target);
    await openVariant(page, "Insert", "Base");
    await editCardButton(page, card).click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: `Remove player ${PLAYER}` })).toBeVisible();
    await expect(drawer.getByLabel("Player picker", { exact: true }).getByText("Football")).toBeVisible();
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeHidden();

    // Clean up.
    await deleteCardButton(page, card).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await confirmDeleteCardButton(page, card).click();
    await expect(editCardButton(page, card)).toBeHidden();
  },
);
