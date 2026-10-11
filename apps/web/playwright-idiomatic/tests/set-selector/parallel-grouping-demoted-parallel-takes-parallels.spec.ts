// Spec: .maestro/flows/set-selector/parallel-grouping-demoted-parallel-takes-parallels.yaml
// NEO-300: a saved parallel sent back to the top level can take a parallel of
// its own in the same save (a demotion plus a re-parenting, one Save).
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { createCustomEntry, drillToCustom } from "../../support/batch5/custom";

test(
  "Group Parallels — a saved parallel sent back to the top level takes a parallel of its own in the same save (NEO-300)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ page, signIn, env }) => {
    const A = env.ATTEMPT_ID;
    const W = env.WORKER_INDEX;
    const stars = `${A} Stars`;
    const gold = `${A} Stars Gold`;
    const blue = `${A} Stars Blue`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustom(page, {
      sport: `E2E Test Sport ${W}`,
      year: "2026",
      manufacturer: "Topps",
      set: `pg-demote-${W}-${A}`,
      variantType: "Insert",
    });
    for (const name of [stars, gold, blue]) await createCustomEntry(page, "Inserts", name);
    await expect(page.getByText(blue)).toBeVisible();

    const dialog = page.getByRole("dialog", { name: "Group Parallels" });
    const open = async () => {
      await page.getByRole("button", { name: "Group Parallels" }).click();
      await expect(dialog.getByText(/Drag inserts under a parent/)).toBeVisible();
    };

    // Save the suggested grouping: Gold and Blue become parallels of Stars.
    await open();
    await dialog.getByRole("button", { name: "Accept all suggestions (2)" }).click();
    await expect(dialog.getByText("2 promotions, 0 demotions")).toBeVisible();
    await dialog.getByRole("button", { name: "Save 2 changes" }).click();
    await expect(dialog).toBeHidden();

    // Reopen: Gold is a saved parallel and has no parallels box of its own.
    await open();
    await expect(dialog.getByText("No changes yet")).toBeVisible();
    const removeGold = dialog.getByRole("button", { name: `Remove ${gold} from parallels` });
    await expect(removeGold).toBeVisible();
    const goldBox = dialog.getByText(`Parallels of "${gold}"`);
    await expect(goldBox).toBeHidden();

    // Send Gold back to the top level: it grows a "Parallels of" box.
    await removeGold.click();
    await expect(goldBox).toBeVisible();
    await expect(dialog.getByText("0 promotions, 1 demotion")).toBeVisible();

    // Pick Blue and drop it into Gold's box.
    await dialog.getByText(blue, { exact: true }).click();
    // Every drop target offers the move.
    await expect(dialog.getByText("Click here to make the selected row a parallel").first()).toBeVisible();
    await goldBox.click();
    await expect(dialog.getByText("0 promotions, 1 demotion, 1 re-parented")).toBeVisible();

    await dialog.getByRole("button", { name: "Save 2 changes" }).click();
    await expect(dialog).toBeHidden();

    // Gold now lists Blue as its parallel.
    await page.getByText(gold, { exact: true }).click();
    await expect(page.getByText("Parallels", { exact: true }).first()).toBeVisible();
    await expect(page.getByText(blue)).toBeVisible();
  },
);
