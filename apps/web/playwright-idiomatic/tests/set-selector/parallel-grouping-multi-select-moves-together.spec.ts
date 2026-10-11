// Spec: .maestro/flows/set-selector/parallel-grouping-multi-select-moves-together.yaml
// NEO-300: two ticked rows move under one insert with a single press and a
// single Save.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { createCustomEntry, drillToCustom } from "../../support/batch5/custom";

test(
  "Group Parallels — two ticked rows move under one insert with a single press and a single Save (NEO-300)",
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
    for (const name of [aces, bolt, comet]) await createCustomEntry(page, "Inserts", name);
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

    await dialog.getByText(`Parallels of "${aces}"`).click();
    await expect(dialog.getByText("2 promotions, 0 demotions")).toBeVisible();

    await dialog.getByRole("button", { name: "Save 2 changes" }).click();
    await expect(dialog).toBeHidden();

    // Aces lists both as its parallels.
    await page.getByText(aces, { exact: true }).click();
    await expect(page.getByText("Parallels", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(bolt)).toBeVisible();
    await expect(page.getByText(comet)).toBeVisible();
  },
);
