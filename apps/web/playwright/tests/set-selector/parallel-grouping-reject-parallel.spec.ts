// Origin: .maestro/flows/set-selector/parallel-grouping-reject-parallel.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, columnOption, addCustomEntry, drillToCustomSet } from "../../support/set-builder";

test(
  "Parallel Grouping — reject (✕) button moves a parallel back to top-level inserts",
  { tag: ["@parallel-grouping"] },
  async ({ page, signIn, env }) => {
    const id = env.ATTEMPT_ID;
    const stars = `${id} Stars`;
    const gold = `${id} Stars Gold`;
    const champions = `${id} Champions`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustomSet(page, env, { set: `pg-reject-${env.WORKER_INDEX}-${id}`, variantType: "Insert" });

    for (const name of [stars, gold, champions]) await addCustomEntry(page, "Inserts", name);
    await expect(columnOption(page, "Inserts", champions)).toBeVisible();

    await page.getByRole("button", { name: "Group Parallels" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Drag inserts under a parent/)).toBeVisible();
    await expect(dialog.getByText("Top-level inserts")).toBeVisible();
    await dialog.getByRole("button", { name: /Accept all suggestions/ }).click();
    await expect(dialog.getByText(/\d+ promotion/)).toBeVisible();
    await expect(dialog.getByText(new RegExp(`Parallels of.*${stars}`))).toBeVisible();

    // Rejecting the placed parallel moves it back to the top level.
    await dialog.getByRole("button", { name: `Remove ${gold} from parallels` }).click();
    await expect(dialog.getByText("No changes yet")).toBeVisible();
    await expect(dialog.getByRole("button", { name: gold, exact: true })).toBeVisible();
    await expectAccessible(page, { within: dialog, label: "Group Parallels dialog after a reject" });

    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText(/Drag inserts under a parent/)).toBeHidden();
  },
);
