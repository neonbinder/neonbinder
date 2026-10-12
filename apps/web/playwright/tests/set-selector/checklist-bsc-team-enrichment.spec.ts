// Origin: .maestro/flows/set-selector/checklist-bsc-team-enrichment.yaml (Maestro suite retired in NEO-341; see git history)
// A synced BSC Base card (2024 Topps Chrome #300, Julio Rodriguez) carries its
// real, marketplace-resolved team into the card detail drawer. READ-ONLY on
// the shared, pre-synced checklist: nothing is typed, toggled or picked, so
// closing the drawer leaves it exactly as found.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { drillToBaseVariant, setBuilderReady } from "../../support/set-builder";

test(
  "Checklist — a synced Base card carries its real BSC-resolved team into the card detail drawer (NEO-90, NEO-195)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToBaseVariant(page, env);

    // Card #300 sits at the bottom of the virtualised list; click() scrolls it in.
    await page.getByRole("button", { name: /^Edit card 300(,|$)/ }).click();

    // The drawer is open on the right card.
    const drawer = page.getByRole("dialog");
    const cardName = drawer.getByRole("textbox", { name: "Card name" });
    await expect(cardName).toBeVisible();
    await expect(drawer.getByText(/Card #300/)).toBeVisible();
    await expect(cardName).toHaveValue(/Julio Rodriguez/);

    // The resolved team (a TeamPicker chip). The exact name: if BSC ever
    // returns a different team for this printed card it is a data regression.
    await expect(drawer.getByText("Teams", { exact: true })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Remove team Seattle Mariners" })).toBeVisible();

    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(cardName).toBeHidden();
  },
);
