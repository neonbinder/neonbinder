// Spec: .maestro/flows/set-selector/cards-parallel-custom.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, columnOption, syncChecklistButton } from "../../support/set-builder";
import { addCustomEntry, drillToCustomSet } from "../../support/batch4/custom-drill";

test(
  "Add custom Parallel — a hand-added parallel appears in the Parallels column and is selectable",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    await drillToCustomSet(page, env, {
      setName: `parallel-feature-${env.WORKER_INDEX}`,
      variantType: "Parallel",
    });

    await addCustomEntry(page, "Parallels", "Prizm Gold");

    // NEO-239: a hand-added row carries no marketplace pills; it is simply in the column.
    const row = columnOption(page, "Parallels", "Prizm Gold");
    await expect(row).toBeVisible();

    // It is a real, selectable entry: selecting it opens its (empty) checklist.
    await row.click();
    await expect(syncChecklistButton(page)).toBeVisible();
    await expect(page.getByText("No cards in this checklist yet.")).toBeVisible();
  },
);
