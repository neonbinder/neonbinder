// Origin: .maestro/flows/set-selector/set-rename-survives-resync-and-suggests-bsc-name.yaml (Maestro suite retired in NEO-341; see git history)
// A set the operator renamed ("TCG") survives a forced Sync Sets with its
// subtree, and BSC's own name comes back as a suggestion the operator can take.
// Sole writer of the 2024 Hockey Topps NHL Sticker Collection set's name; it
// ends renamed back, so a rerun starts from the same place.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import {
  COLD_SYNC,
  columnOption,
  columnSearch,
  columnSelection,
  drillToColdManufacturer,
  setBuilderReady,
} from "../../support/set-builder";

const ORIGINAL = "Topps NHL Sticker Collection";
const RENAMED = "TCG";

test(
  "A renamed set survives a forced Sync Sets with its subtree, and BSC's own name comes back as a suggestion the operator can accept",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToColdManufacturer(page, env, { sport: "Hockey", year: "2024", manufacturer: "Topps" });

    // The set is listed under whichever name it currently carries.
    await columnSearch(page, "Sets").fill("C");
    const row = columnOption(page, "Sets", ORIGINAL).or(columnOption(page, "Sets", RENAMED));
    await row.click();
    await expect(page.getByRole("heading", { name: "Variant Types", exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await expect(columnOption(page, "Variant Types", "Base")).toBeVisible({ timeout: 60_000 });

    // Rename it to TCG unless a previous run left it renamed.
    if (await columnSelection(page, "Sets", ORIGINAL).isVisible()) {
      await page.getByRole("button", { name: `Rename ${ORIGINAL}` }).click();
      const edit = page.getByRole("textbox", { name: `Edit name for ${ORIGINAL}` });
      await expect(edit).toBeVisible();
      await edit.fill(RENAMED);
      await edit.press("Enter");
    }
    await expect(page.getByText(/Attributes for TCG/)).toBeVisible();

    // A forced Sync Sets: the rename survives, BSC's name returns as a suggestion.
    await page.getByRole("button", { name: "Sync Sets" }).click();
    await expect(page.getByText("1 name to check")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/Attributes for TCG/)).toBeVisible();
    await expect(columnOption(page, "Variant Types", "Base")).toBeVisible();

    await page.getByRole("button", { name: "1 name to check — review suggestions" }).click();
    const review = page.getByRole("dialog", { name: "Name Check — Sets" });
    await expect(review).toBeVisible();
    await expect(review.getByText(`BSC calls it "${ORIGINAL}"`)).toBeVisible();

    await review
      .getByRole("button", { name: `Take it — rename "${RENAMED}" to "${ORIGINAL}" (from BSC)` })
      .click();
    await expect(review.getByText("1 to take · 0 to keep")).toBeVisible();
    await review.getByRole("button", { name: "Apply decisions" }).click();
    await expect(page.getByText("1 renamed")).toBeVisible();

    // Taken: the set carries BSC's name again, and the suggestion is gone.
    await expect(page.getByText(new RegExp(`Attributes for ${ORIGINAL}`))).toBeVisible();
    await expect(page.getByText(RENAMED, { exact: true })).toBeHidden();
    await expect(page.getByText("1 name to check")).toBeHidden();
  },
);
