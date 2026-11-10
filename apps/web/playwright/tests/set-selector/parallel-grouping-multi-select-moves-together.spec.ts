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
// selection, and the footer says how many picked rows it is hiding. The
// count beside the field is announced once typing pauses (a debounced status),
// and a filter matching nothing says so in both panes.
//
// NEO-472 keyboard: while a selection is up each box is a Tab stop, and Enter
// or Space on the box itself places the selection there (its description
// says so). The hidden-rows move is made with Enter; a second move with Space.
//
// MINTED NAMES are single tokens from env.ATTEMPT_TOKEN (set `pgmulti<token>`;
// inserts `<token> Aces` / `Bolt` / `Comet`: the token plus a distinct second
// word, so "every word in any order" is still exercised). R7a: one per-attempt
// hand-made set under `E2E Test Sport <worker>` › 2026 › Topps.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, addCustomEntry, drillToCustom } from "../../support/set-builder";

test(
  "Group Parallels — two ticked rows move under one insert with a single press and a single Save, even while the filter hides them (NEO-300, NEO-472)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ page, signIn, env }) => {
    const T = env.ATTEMPT_TOKEN;
    const W = env.WORKER_INDEX;
    const aces = `${T} Aces`;
    const bolt = `${T} Bolt`;
    const comet = `${T} Comet`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustom(page, {
      sport: `E2E Test Sport ${W}`,
      year: "2026",
      manufacturer: "Topps",
      set: `pgmulti${T}`,
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

    // The filter's count: shown beside the field at once, and announced by a
    // status of its own once typing pauses (500 ms). Once both have it, the
    // words appear twice (GUIDE: live regions duplicate status text).
    const filterCount = (text: string) => dialog.getByText(text, { exact: true });
    const expectFilterCount = async (text: string) => {
      await expect(dialog.getByRole("status").filter({ hasText: new RegExp(`^${text}$`) })).toBeVisible();
      await expect(filterCount(text)).toHaveCount(2);
    };
    // Pressed on the box itself, the keys a keyboard user places with.
    const placeByKey = async (box: ReturnType<typeof boxOf>, key: "Enter" | " ") => {
      await box.focus();
      await expect(box).toBeFocused();
      await expect(box).toHaveAccessibleDescription(/Press Enter to move the selection here\./);
      await box.press(key);
    };

    // The filter narrows both panes at once: case-insensitive, words in any
    // order. The ticked rows it hides stay ticked, and the footer says so.
    const filter = dialog.getByRole("textbox", { name: "Filter inserts" });
    await filter.fill(`ACES ${T.toUpperCase()}`);
    await expectFilterCount("1 of 3 inserts");
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
    await expect(filterCount("1 of 3 inserts")).toHaveCount(0);

    // Filtered again, Enter on Aces' box moves both hidden rows.
    await filter.fill(`aces ${T}`);
    await expect(dialog.getByText("2 selected (2 hidden by the filter)", { exact: true })).toBeVisible();
    await placeByKey(boxOf(aces), "Enter");
    await expect(dialog.getByText("2 promotions, 0 demotions")).toBeVisible();
    // A shown box shows every parallel it holds, matching or not.
    await expect(boxOf(aces).getByRole("group", { name: bolt, exact: true })).toBeVisible();
    await expect(boxOf(aces).getByRole("group", { name: comet, exact: true })).toBeVisible();
    await expectFilterCount("1 of 1 inserts");

    // An insert also shows when one of its parallels matches.
    await filter.fill("bolt");
    await expect(row(aces)).toBeVisible();
    await expect(boxOf(aces).getByRole("group", { name: comet, exact: true })).toBeVisible();
    await expectFilterCount("1 of 1 inserts");

    // The clear button empties the filter and hands focus back to it.
    await dialog.getByRole("button", { name: "Clear the insert filter" }).click();
    await expect(filter).toHaveValue("");
    await expect(filter).toBeFocused();
    await expect(row(aces)).toBeVisible();
    await expect(filterCount("1 of 1 inserts")).toHaveCount(0);

    // A second keyboard move, with Space: ✕ sends Comet back to the top
    // level, ticked again it goes back into Aces' box.
    await boxOf(aces).getByRole("button", { name: `Remove ${comet} from parallels` }).click();
    await expect(dialog.getByText("1 promotion, 0 demotions")).toBeVisible();
    await dialog.getByRole("checkbox", { name: `Select ${comet}` }).click();
    await expect(dialog.getByText("1 selected", { exact: true })).toBeVisible();
    await placeByKey(boxOf(aces), " ");
    await expect(dialog.getByText("2 promotions, 0 demotions")).toBeVisible();
    await expect(boxOf(aces).getByRole("group", { name: comet, exact: true })).toBeVisible();
    await expect(row(comet)).toHaveCount(0);

    // A filter that matches nothing says so on the left, and the right pane
    // holds no box at all.
    const nothing = `nomatch${T}`;
    await filter.fill(nothing);
    await expect(inserts.getByText(`No inserts match "${nothing}"`, { exact: true })).toBeVisible();
    await expect(boxes.getByText(`No parallels to show for "${nothing}"`, { exact: true })).toBeVisible();
    await expect(boxes.getByRole("group", { name: /^Parallels of / })).toHaveCount(0);
    await expectFilterCount("0 of 1 inserts");
    await expectAccessible(page, { within: dialog, label: "Group Parallels dialog, filter matching nothing" });
    await filter.press("Escape");
    await expect(filter).toHaveValue("");
    await expect(boxOf(aces)).toBeVisible();

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
