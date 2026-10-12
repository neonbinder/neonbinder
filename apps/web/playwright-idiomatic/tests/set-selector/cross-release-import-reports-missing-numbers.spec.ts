// Spec: .maestro/flows/set-selector/cross-release-import-reports-missing-numbers.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";
import { drillToCustom, customSport } from "../../support/batch4/custom-drill";
import { openCrossListForm, pickCrossListSource } from "../../support/batch4/cross-list";

test(
  "Cross-release — the import names every card number it could not find in the chosen source set",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const w = env.WORKER_INDEX;
    const custom = (setName: string) => ({
      sport: customSport(env),
      year: "2026",
      manufacturer: "Topps",
      setName,
      variantType: "Insert",
      variant: "Base",
    });

    await signIn("/set-selector");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    // Two empty sets: the source (xbs) and the one importing into it (xbg).
    await drillToCustom(page, custom(`xbs-${w}`));
    await drillToCustom(page, custom(`xbg-${w}`));

    const modal = await openCrossListForm(page);
    await pickCrossListSource(page, env, { set: `xbs-${w}` });

    const numbers = modal.getByRole("textbox", { name: "Card numbers to cross-list" });
    await numbers.fill("8801-8803");
    await expect(numbers).toHaveValue("8801-8803");
    await numbers.press("Enter");

    await expect(modal.getByText(/Not found in source set: 8801, 8802, 8803/)).toBeVisible();
    await expect(modal.getByText(/Linked 0 cards/)).toBeVisible();

    await modal.getByRole("button", { name: "Cancel cross-release import" }).click();
    await expect(modal).toBeHidden();
  },
);
