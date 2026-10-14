// Origin: .maestro/flows/set-selector/checklist-renders-rich-fields.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { drillToBaseVariant, setBuilderReady } from "../../support/set-builder";

test(
  "Checklist — card rows render card number, sub-line, attribute badges, and platform badges",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // The seed pre-synced the 2024 Topps Chrome Base checklist.
    await drillToBaseVariant(page, env);

    // A card row's number cell: "#123" on its own (a column's twin notice
    // reads "Anime (SportLots #378117, #378118)", which is not a card row).
    await expect(page.getByText(/^#\d\S*$/).first()).toBeVisible();

    // The BSC platform badge is on marketplace-sourced rows. (The SL badge is
    // deliberately not asserted: the list opens on the SL-less tail.)
    await expect(page.getByText("BSC", { exact: true }).first()).toBeVisible();

    // A rookie badge exists somewhere in the base checklist.
    await expect(page.getByText("RC", { exact: true }).first()).toBeVisible();

    // The populated checklist is a new state: check it, rows and badges included.
    await expectAccessible(page, { label: "Base checklist with rich card rows" });

    // NEO-345: BSC's RC token is read into NB's vocabulary at the sync (it stays
    // "RC", and the card is a rookie), so a rookie card's drawer shows the RC chip
    // pressed. The search box narrows the virtualised list to the rookie cards
    // (client-side, writes nothing); opening the drawer and leaving it writes
    // nothing either, so the set stays read-only here.
    await page.getByRole("searchbox", { name: "Search cards" }).fill("rookie");
    await expect(page.getByText(/^[0-9]+ of [0-9]+ cards?$/)).toBeVisible();
    await page.getByRole("button", { name: /^Edit card / }).first().click();
    const drawer = page.getByRole("dialog");
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Toggle RC" })).toHaveAttribute("aria-pressed", "true");
    await drawer.getByRole("button", { name: "Done editing card" }).click();
    await expect(drawer.getByRole("textbox", { name: "Card name" })).toBeHidden();
  },
);
