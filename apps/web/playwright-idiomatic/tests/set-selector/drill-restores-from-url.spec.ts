// Spec: .maestro/flows/set-selector/drill-restores-from-url.yaml
// NEO-224: the drill lives in the URL. Back undoes the last pick, and coming
// back to the page restores the drill from the address with keyboard focus in
// the deepest open column. Typing here goes to whatever holds focus, never to
// a field the test clicked first: that IS the feature.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import {
  columnHeading,
  columnOption,
  columnSearch,
  columnSelection,
  drillToSet,
  setBuilderReady,
} from "../../support/set-builder";

test(
  "Set Builder drill lives in the URL — Back undoes the last pick, and coming back to the page restores the drill from the address with focus in the deepest open column (NEO-224)",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToSet(page, env);
    await expect(columnSelection(page, "Sets", "Topps Chrome")).toBeVisible();

    // Back undoes the Set pick: the Sets column is open again, focused.
    await page.goBack();
    await expect(columnSearch(page, "Sets")).toBeFocused();
    await expect(columnSelection(page, "Manufacturers", "Topps")).toBeVisible();
    await expect(columnHeading(page, "Variant Types")).toBeHidden();

    // Keyboard only: type goes to the focused search, Enter picks the match.
    await page.keyboard.type("Topps Chrome");
    await expect(columnSearch(page, "Sets")).toHaveValue("Topps Chrome");
    await expect(columnOption(page, "Sets", "Topps Chrome")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    await expect(columnSelection(page, "Sets", "Topps Chrome")).toBeVisible();

    // Focus follows into Variant Types.
    await page.keyboard.type("Ins");
    await expect(columnSearch(page, "Variant Types")).toHaveValue("Ins");

    // Leave for another admin page and type there.
    await page.getByRole("navigation", { name: "Admin sections" }).getByRole("link", { name: "Teams" }).click();
    await expect(page.getByRole("heading", { name: "Team Management" })).toBeVisible();
    const filter = page.getByRole("textbox", { name: "Filter teams" });
    await filter.fill("zz");
    await expect(filter).toHaveValue("zz");

    // Coming back restores the drill from the address, focus in the deepest column.
    await page.goBack();
    await expect(setBuilderReady(page)).toBeVisible();
    await expect(columnSelection(page, "Sets", "Topps Chrome")).toBeVisible();
    await expect(columnHeading(page, "Variant Types")).toBeVisible();
    const vtSearch = columnSearch(page, "Variant Types");
    await expect(vtSearch).toHaveValue("");
    await expect(vtSearch).toHaveAttribute("placeholder", "Search variant types...");
    await expect(vtSearch).toBeFocused();

    await page.keyboard.type("Base");
    await expect(vtSearch).toHaveValue("Base");
    await expect(columnOption(page, "Variant Types", "Base")).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(columnSelection(page, "Variant Types", "Base")).toBeVisible();
  },
);
