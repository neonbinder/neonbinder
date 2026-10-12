// Origin: .maestro/flows/set-selector/parallel-grouping-cancel-discards.yaml (Maestro suite retired in NEO-341; see git history)
// Group Parallels: Cancel (and a backdrop click) ask to discard pending moves;
// discarding closes the dialog and a reopen shows the original, unsaved state.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, addCustomEntry, drillToCustom } from "../../support/set-builder";

test(
  "Parallel Grouping — Cancel discards changes (reopen shows original); also closes via backdrop",
  { tag: ["@parallel-grouping"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const W = env.WORKER_INDEX;
    const stars = `${A} Stars`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustom(page, {
      sport: `E2E Test Sport ${W}`,
      year: "2026",
      manufacturer: "Topps",
      set: `pg-cancel-${W}-${A}`,
      variantType: "Insert",
    });
    for (const name of [stars, `${stars} Gold`, `${stars} Red`]) {
      await addCustomEntry(page, "Inserts", name, { confirm: "required" });
    }

    const dialog = page.getByRole("dialog", { name: "Group Parallels" });
    const open = async () => {
      await page.getByRole("button", { name: "Group Parallels" }).click();
      await expect(dialog.getByText(/Drag inserts under a parent/)).toBeVisible();
      await expect(dialog.getByText("Top-level inserts")).toBeVisible();
    };
    const discardConfirm = page.getByRole("button", { name: /^Discard .*pending move/ });

    // Accept the suggested grouping, then Cancel -> Discard.
    await open();
    await dialog.getByRole("button", { name: /Accept all suggestions/ }).click();
    await expect(dialog.getByText(/[0-9]+ promotion/)).toBeVisible();
    await expect(dialog.getByText(new RegExp(`Parallels of .*${A} Stars`)).first()).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Group Parallels dialog with accepted suggestions" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText(/Nothing has been saved yet/)).toBeVisible();
    await expectAccessible(page, {
      within: page.getByRole("dialog", { name: /^Discard .*pending move/ }),
      label: "Discard pending moves confirm",
    });
    await discardConfirm.click();
    await expect(dialog).toBeHidden();

    // Reopen: the originals are still top-level inserts, and suggestions are back.
    await expect(page.getByText(stars, { exact: true })).toBeVisible();
    await expect(page.getByText(`${stars} Gold`)).toBeVisible();
    await expect(page.getByText(`${stars} Red`)).toBeVisible();

    await open();
    await expect(dialog.getByText(/[0-9]+ promotion/)).toBeVisible();
    await expect(dialog.getByText("Suggested").first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Save [0-9]+ change/ })).toBeVisible();

    // Same again, closed through the backdrop instead of Cancel.
    await dialog.getByRole("button", { name: /Accept all suggestions/ }).click();
    await expect(dialog.getByText(/[0-9]+ promotion/)).toBeVisible();
    await expect(dialog.getByText(new RegExp(`Parallels of .*${A} Stars`)).first()).toBeVisible();
    await dialog.click({ position: { x: 5, y: 150 } });
    await expect(page.getByText(/Nothing has been saved yet/)).toBeVisible();
    await discardConfirm.click();
    await expect(dialog).toBeHidden();

    // A third open still shows the original; Cancel -> Discard once more.
    await open();
    await expect(dialog.getByText("Suggested").first()).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Save [0-9]+ change/ })).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await discardConfirm.click();
    await expect(dialog).toBeHidden();

    await expect(page.getByRole("button", { name: "Add custom Inserts" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Group Parallels" })).toBeVisible();
    await expectAccessible(page, { label: "Inserts column after the discards" });
  },
);
