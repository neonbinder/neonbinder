// Origin: .maestro/flows/set-selector/cross-release-import-reports-missing-numbers.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady, drillToCustom, customSport } from "../../support/set-builder";
import { openCrossListForm, pickCrossListSource } from "../../support/cross-list";

test(
  "Cross-release — the import names every card number it could not find in the chosen source set",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    const w = env.WORKER_INDEX;
    const custom = (setName: string) => ({
      sport: customSport(env),
      year: "2026",
      manufacturer: "Topps",
      set: setName,
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
    await expectAccessible(page, { within: modal, label: "Cross-release import reporting missing numbers" });

    await modal.getByRole("button", { name: "Cancel cross-release import" }).click();
    await expect(modal).toBeHidden();
  },
);
