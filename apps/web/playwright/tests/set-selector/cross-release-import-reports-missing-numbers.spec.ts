// Port of .maestro/flows/set-selector/cross-release-import-reports-missing-numbers.yaml
import { test, expect } from "../../support/fixtures";
import { mrx } from "../../support/maestro";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";
import { utilPickCrossListSource } from "../../support/subflows/set-selector/util-pick-cross-list-source";

test(
  "Cross-release — the import names every card number it could not find in the chosen source set",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const W = env.WORKER_INDEX;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustom(m, {
      SPORT: `E2E Test Sport ${W}`,
      YEAR: "2026",
      MANUFACTURER: "Topps",
      SET_NAME: `xbs-${W}`,
      VARIANT_TYPE: "Insert",
      VARIANT: "Base",
    });

    await utilDrillToCustom(m, {
      SPORT: `E2E Test Sport ${W}`,
      YEAR: "2026",
      MANUFACTURER: "Topps",
      SET_NAME: `xbg-${W}`,
      VARIANT_TYPE: "Insert",
      VARIANT: "Base",
    });

    await m.scrollUntilVisible(m.id("Open add cross-release cards form"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Open add cross-release cards form"));
    await m.waitVisible(m.id("Add cross-release cards"), 7_000);

    await utilPickCrossListSource(m, {
      SOURCE_SPORT: `E2E Test Sport ${W}`,
      SOURCE_YEAR: "2026",
      SOURCE_MANUFACTURER: "Topps",
      SOURCE_SET: `xbs-${W}`,
      SOURCE_VARIANT_TYPE: "Insert",
      SOURCE_VARIANT: "Base",
    });

    await m.tapOn(m.id("Card numbers to cross-list"));
    await m.inputText("8801-8803");
    // assertVisible: id + text (the input's value)
    const field = await m.resolve(m.id("Card numbers to cross-list"));
    await expect(field).toHaveValue(mrx("8801-8803"), { timeout: 7_000 });
    await m.pressKey("Enter");

    await m.waitVisible(".*Not found in source set: 8801, 8802, 8803.*", 7_000);
    await m.assertVisible(".*Linked 0 cards.*");

    await m.tapOn(m.id("Cancel cross-release import"));
    await m.waitNotVisible(m.id("Add cross-release cards"), 7_000);
  },
);
