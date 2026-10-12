// Spec: .maestro/flows/set-selector/move-parallels-of-inserts-custom.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, columnOption, columnSearch } from "../../support/set-builder";
import { addCustomEntry, drillToCustomSet } from "../../support/batch4/custom-drill";

test(
  "Move parallels-of-inserts — suggestions pre-placed on open, Accept All clears badges, Save persists nesting",
  { tag: ["@parallel-grouping", "@set-selector"] },
  async ({ page, signIn, env }) => {
    const setName = `pg-move-${env.WORKER_INDEX}`;
    const stars = `${env.ATTEMPT_ID} Stars`;
    const gold = `${stars} Gold`;
    const red = `${stars} Red`;

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
    await drillToCustomSet(page, env, { setName, variantType: "Insert" });

    for (const name of [stars, gold, red]) await addCustomEntry(page, "Inserts", name);

    await page.getByRole("button", { name: "Group Parallels" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText(/Drag inserts under a parent/)).toBeVisible();
    await expect(dialog.getByText(/Accept all suggestions/)).toBeVisible();
    // Suggestions are pre-placed: "<stars> Gold" and "<stars> Red" promote under "<stars>".
    await expect(dialog.getByText(/\d+ promotion/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Save \d+ change/ })).toBeVisible();

    await dialog.getByRole("button", { name: /Accept all suggestions/ }).click();
    await expect(dialog.getByText("Suggested", { exact: true })).toBeHidden();
    await expect(dialog.getByText(/\d+ promotion/)).toBeVisible();
    await dialog.getByRole("button", { name: /Save \d+ change/ }).click();
    await expect(page.getByText(/Drag inserts under a parent/)).toBeHidden();

    // The nesting persists across a full navigation away and back.
    await page.goto("/dashboard");
    await expect(page.getByText("COMING SOON")).toBeVisible({ timeout: 20_000 });
    await page.goto("/set-selector");
    await expect(page.getByText("Baseball", { exact: true })).toBeVisible({ timeout: 60_000 });
    await drillToCustomSet(page, env, { setName, variantType: "Insert" });

    // The children no longer sit at the top level; opening the parent shows them as its parallels.
    await expect(columnOption(page, "Inserts", gold)).toBeHidden();
    await expect(columnOption(page, "Inserts", red)).toBeHidden();
    await columnSearch(page, "Inserts").fill(stars);
    await columnOption(page, "Inserts", stars).click();
    await expect(page.getByRole("heading", { name: "Parallels", exact: true })).toBeVisible();
    await expect(page.getByText(gold)).toBeVisible();
    await expect(page.getByText(red)).toBeVisible();
  },
);
