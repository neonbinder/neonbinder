// Spec: .maestro/flows/admin/player-sports-multi-sport-membership.yaml
// NEO-313 case B: a football player is given Baseball too. He is listed as a
// baseball player ("Also: Baseball"), a baseball card's picker finds him on
// its default path, and Baseball cannot be removed while that card links him.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { addPlayerByHand, expectPlayersLoaded } from "../../support/batch1/players";
import { drillToHandMadeBaseEntry } from "../../support/batch1/custom";

test(
  "Player sports — give a football player Baseball too; he is listed as a baseball player, a baseball card's picker finds him without a switch, and Baseball cannot be removed while that card links him (NEO-313)",
  { tag: ["@admin"] },
  async ({ page, signIn, env }) => {
    const player = `Gm${env.ATTEMPT_TOKEN}`;
    const cardNumber = `316-${env.ATTEMPT_ID}`;
    const set = `msp-${env.WORKER_INDEX}`;

    await signIn("/admin/players");
    await expectPlayersLoaded(page, LAUNCH_GATE);

    // STEP 1: a football player, then Baseball as well.
    await addPlayerByHand(page, player, "Football");
    await page.getByRole("button", { name: "Add sport", exact: true }).click();
    await page.getByRole("button", { name: "Add sport Baseball" }).click();
    await expect(page.getByText("Added Baseball.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove sport Baseball" })).toBeVisible();

    // STEP 2: he is a baseball player now. Reload, narrow to him, scope to Baseball.
    await page.goto("/admin/players");
    await expectPlayersLoaded(page, 20_000);
    await page.getByLabel("Filter players").fill(player);
    const counter = page.getByText(/matches/);
    await expect(counter).toBeVisible();
    await page.getByLabel("Sport", { exact: true }).selectOption({ label: "Baseball" });
    // The Baseball-scoped search returns him through the added-sport leg, and
    // the row says why he is there.
    const row = page.getByRole("button", { name: new RegExp(player) });
    await expect(row).toBeVisible();
    await expect(row.getByText("Also: Baseball")).toBeVisible();

    // STEP 3: a baseball card's picker finds him without a cross-sport switch.
    await drillToHandMadeBaseEntry(page, set);
    await page.getByRole("button", { name: "Open add card form" }).click();
    await page.getByRole("textbox", { name: "Card number" }).fill(cardNumber);
    await page.getByRole("textbox", { name: "Card name" }).fill(`Two Sport Card ${env.ATTEMPT_ID}`);
    await page.getByRole("button", { name: "Add a player to the new card" }).click();
    await page.getByRole("textbox", { name: "Find a player for the new card" }).fill(player);
    // Nothing was switched: the popover still searches the set's sport.
    await expect(page.getByRole("button", { name: "Sport to search for players: Baseball" })).toBeVisible();
    await expect(page.getByRole("option", { name: `Add ${player}` })).toBeVisible();
    // An exact existing match hides the create row.
    await expect(page.getByRole("option", { name: `Create player ${player}` })).toBeHidden();
    await page.getByRole("option", { name: `Add ${player}` }).click();
    await expect(page.getByRole("button", { name: `Remove player ${player}` })).toBeVisible();
    // A click on "Card name" (above the picker) closes the popover.
    await page.getByRole("textbox", { name: "Card name" }).click();
    await expect(page.getByRole("textbox", { name: "Find a player for the new card" })).toBeHidden();
    await page.getByRole("button", { name: "Submit new card" }).click();
    await expect(page.getByRole("textbox", { name: "Card name" })).toBeHidden();

    // STEP 4: Baseball cannot be removed while that card links him.
    await page.goto("/admin/players");
    await expectPlayersLoaded(page, 20_000);
    await page.getByLabel("Filter players").fill(player);
    await expect(counter).toBeVisible();
    await page.getByRole("button", { name: new RegExp(player) }).click();
    await page.getByRole("button", { name: "Remove sport Baseball" }).click();
    await expect(
      page.getByText(new RegExp(`1 card in Baseball sets still link to ${player}\\.`)),
    ).toBeVisible();
    // The refusal wrote nothing: he is still a baseball player.
    await expect(page.getByRole("button", { name: "Remove sport Baseball" })).toBeVisible();

    // His own Cards list shows the card WITHOUT a "Baseball" tag: the tag marks
    // a guest appearance, and Baseball is now one of his own sports.
    const cards = page.getByRole("list", { name: `Cards for ${player}` });
    await expect(cards.getByText(`#${cardNumber}`)).toBeVisible();
    await expect(cards.getByText("Baseball", { exact: true })).toBeHidden();

    // CLEANUP: delete this attempt's card.
    await drillToHandMadeBaseEntry(page, set);
    await page.getByRole("button", { name: new RegExp(`^Delete card ${cardNumber}(, .*)?$`) }).click();
    await expect(page.getByText("Confirm?")).toBeVisible();
    await page.getByRole("button", { name: new RegExp(`^Confirm delete card ${cardNumber}(, .*)?$`) }).click();
    await expect(page.getByRole("button", { name: new RegExp(`^Edit card ${cardNumber}(, .*)?$`) })).toBeHidden();
  },
);
