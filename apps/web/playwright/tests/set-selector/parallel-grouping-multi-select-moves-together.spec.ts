// Origin: .maestro/flows/set-selector/parallel-grouping-multi-select-moves-together.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-300: two ticked rows move under one insert with a single press and a
// single Save.
//
// NEO-472: the press is on the insert's box in the right-hand pane, and it
// moves every ticked row even while the filter hides them. The filter is view
// state over both panes: it narrows the rows on the left and their boxes on
// the right together (case-insensitive, every word in any order; an insert
// also shows when one of its parallels matches, and its box then shows all
// of them), Escape clears it without closing the dialog or dropping the
// selection, and the footer says how many picked rows it is hiding.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, addCustomEntry, drillToCustom } from "../../support/set-builder";

test(
  "Group Parallels — two ticked rows move under one insert with a single press and a single Save, even while the filter hides them (NEO-300, NEO-472)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const W = env.WORKER_INDEX;
    const aces = `${A} Aces`;
    const bolt = `${A} Bolt`;
    const comet = `${A} Comet`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustom(page, {
      sport: `E2E Test Sport ${W}`,
      year: "2026",
      manufacturer: "Topps",
      set: `pg-multi-${W}-${A}`,
      variantType: "Insert",
    });
    for (const name of [aces, bolt, comet]) await addCustomEntry(page, "Inserts", name, { confirm: "required" });
    await expect(page.getByText(comet)).toBeVisible();

    const dialog = page.getByRole("dialog", { name: "Group Parallels" });
    await page.getByRole("button", { name: "Group Parallels" }).click();
    await expect(dialog.getByText(/Drag inserts under a parent/)).toBeVisible();
    await expect(dialog.getByText("No changes yet")).toBeVisible();

    // Tick two rows; the target offers to take both at once.
    await dialog.getByRole("checkbox", { name: `Select ${bolt}` }).click();
    await dialog.getByRole("checkbox", { name: `Select ${comet}` }).click();
    await expect(dialog.getByText("2 selected", { exact: true })).toBeVisible();
    await expect(dialog.getByText("Click here to make the 2 selected rows parallels").first()).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Group Parallels dialog with two rows ticked" });

    // NEO-472: the rows on the left, one box per row on the right.
    const inserts = dialog.getByRole("region", { name: "Inserts" });
    const boxes = dialog.getByRole("region", { name: "Parallels by insert" });
    const row = (name: string) => inserts.getByRole("group", { name, exact: true });
    const boxOf = (name: string) => boxes.getByRole("group", { name: `Parallels of "${name}"`, exact: true });
    await expect(row(bolt)).toBeVisible();
    await expect(boxOf(aces)).toBeVisible();
    await expect(boxOf(bolt)).toBeVisible();

    // The filter narrows both panes at once: case-insensitive, words in any
    // order. The ticked rows it hides stay ticked, and the footer says so.
    const filter = dialog.getByRole("textbox", { name: "Filter inserts" });
    await filter.fill(`ACES ${A.toUpperCase()}`);
    await expect(dialog.getByText("1 of 3 inserts", { exact: true })).toBeVisible();
    await expect(row(aces)).toBeVisible();
    await expect(boxOf(aces)).toBeVisible();
    await expect(row(bolt)).toHaveCount(0);
    await expect(row(comet)).toHaveCount(0);
    await expect(boxOf(bolt)).toHaveCount(0);
    await expect(boxOf(comet)).toHaveCount(0);
    await expect(dialog.getByText("2 selected (2 hidden by the filter)", { exact: true })).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Group Parallels dialog filtered, ticked rows hidden" });

    // Escape clears the filter, and only the filter: the dialog stays open
    // and both rows are still ticked.
    await filter.press("Escape");
    await expect(filter).toHaveValue("");
    await expect(row(bolt)).toBeVisible();
    await expect(boxOf(comet)).toBeVisible();
    await expect(dialog.getByText("2 selected", { exact: true })).toBeVisible();
    await expect(dialog.getByText("1 of 3 inserts", { exact: true })).toHaveCount(0);

    // Filtered again, one press on Aces' box moves both hidden rows.
    await filter.fill(`aces ${A}`);
    await expect(dialog.getByText("2 selected (2 hidden by the filter)", { exact: true })).toBeVisible();
    await boxOf(aces).click();
    await expect(dialog.getByText("2 promotions, 0 demotions")).toBeVisible();
    // A shown box shows every parallel it holds, matching or not.
    await expect(boxOf(aces).getByRole("group", { name: bolt, exact: true })).toBeVisible();
    await expect(boxOf(aces).getByRole("group", { name: comet, exact: true })).toBeVisible();
    await expect(dialog.getByText("1 of 1 inserts", { exact: true })).toBeVisible();

    // An insert also shows when one of its parallels matches.
    await filter.fill("bolt");
    await expect(dialog.getByText("1 of 1 inserts", { exact: true })).toBeVisible();
    await expect(row(aces)).toBeVisible();
    await expect(boxOf(aces).getByRole("group", { name: comet, exact: true })).toBeVisible();

    // The clear button empties the filter and hands focus back to it.
    await dialog.getByRole("button", { name: "Clear the insert filter" }).click();
    await expect(filter).toHaveValue("");
    await expect(filter).toBeFocused();
    await expect(row(aces)).toBeVisible();
    await expect(dialog.getByText("1 of 1 inserts", { exact: true })).toHaveCount(0);

    await dialog.getByRole("button", { name: "Save 2 changes" }).click();
    await expect(dialog).toBeHidden();

    // Aces lists both as its parallels.
    await page.getByText(aces, { exact: true }).click();
    await expect(page.getByText("Parallels", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(bolt)).toBeVisible();
    await expect(page.getByText(comet)).toBeVisible();
    await expectAccessible(page, { label: "Aces lists both parallels" });
  },
);
