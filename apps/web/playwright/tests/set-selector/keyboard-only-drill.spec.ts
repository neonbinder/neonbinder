// Origin: .maestro/flows/set-selector/keyboard-only-drill.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-224: the whole drill is keyboard-only. Type to filter, Enter picks the
// first match, focus follows into the next column, and after Base it lands
// on the attributes toggle (or, with SportLots paused and Base unmapped, in
// the Select Base Set dialog). The test never clicks a field: it types into
// whatever holds focus.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnHeading,
  columnOption,
  columnSearch,
  columnSelection,
  setBuilderReady,
  syncChecklistButton,
  type Column,
} from "../../support/set-builder";

test(
  "Set Builder drill is keyboard-only — type to filter, Enter picks the first match, focus follows into the next column and lands on the attributes toggle after Base (NEO-224)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // Each step: the column's search holds focus, typing filters, Enter picks.
    async function typeAndEnter(column: Column, text: string, picked: string) {
      await expect(columnSearch(page, column)).toBeFocused();
      await page.keyboard.type(text);
      await expect(columnSearch(page, column)).toHaveValue(text);
      await expect(columnOption(page, column, text)).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(columnSelection(page, column, picked)).toBeVisible();
    }

    await typeAndEnter("Sports", "Baseball", "Baseball");
    await expect(columnHeading(page, "Years")).toBeVisible();
    await typeAndEnter("Years", "2024", "2024");
    await expect(columnHeading(page, "Manufacturers")).toBeVisible();
    await typeAndEnter("Manufacturers", "Topps", "Topps");
    await expect(columnHeading(page, "Sets")).toBeVisible();
    await typeAndEnter("Sets", "Topps Chrome", "Topps Chrome");
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    await typeAndEnter("Variant Types", "Base", "Base");

    if (!env.SL_PAUSED) {
      // Base is mapped: the row offers a re-map and focus has moved on to the
      // attributes toggle, which Enter opens.
      await expect(page.getByRole("button", { name: /Re-map Base/ })).toBeVisible();
      const edit = page.getByRole("button", { name: "Edit attributes" });
      await expect(edit).toBeVisible();
      await expect(syncChecklistButton(page)).toHaveText(/Refresh/);
      await expect(edit).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("button", { name: "Hide attributes" })).toBeVisible();
    } else {
      // SportLots paused: Base cannot be mapped, so the picker opens instead.
      await expect(page.getByRole("dialog", { name: "Select Base Set" })).toBeVisible();
    }
  },
);
