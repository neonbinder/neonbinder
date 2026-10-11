// Port of .maestro/flows/set-selector/rename-selector-option.yaml
import { test } from "../../support/fixtures";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

test(
  "Selector rename — a set AND a variant type can each be renamed from the attributes panel, and the selection follows the new name (per-worker hand-made set)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const W = env.WORKER_INDEX || 0;
    const A = env.ATTEMPT_ID;
    const SET = `rnm-${W}-${A}`;
    const SETX = `rnmx-${W}-${A}`;
    const VT = `vt-${W}-${A}`;
    const VTX = `vtx-${W}-${A}`;

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustom(m, { SPORT: "Baseball", YEAR: "2024", MANUFACTURER: "Topps", SET_NAME: SET });

    // Rename the set
    await m.scrollUntilVisible(`.*Attributes for ${SET}.*`, { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible(m.id(`Rename ${SET}`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Rename ${SET}`));
    await m.waitVisible(m.id(`Edit name for ${SET}`), 7_000);
    await m.tapOn(m.id(`Edit name for ${SET}`)); // waitToSettleTimeoutMs dropped
    await m.inputText(SETX);
    await m.pressKey("Enter");

    await m.scrollUntilVisible(`.*Attributes for ${SETX}.*`, { centerElement: true, timeout: 7_000 });
    await m.assertNotVisible(SET);

    // Create and rename a variant type
    await m.scrollUntilVisible(m.id("Add custom Variant Types"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id("Add custom Variant Types"));
    await m.assertVisible("Add Custom Entry");
    await m.inputText(VT);
    await m.pressKey("Enter");
    if (await m.isVisible(m.id("Create variant type"))) {
      await m.tapOn(m.id("Create variant type"));
    }
    await m.assertNotVisible("Add Custom Entry");

    await m.scrollUntilVisible(VT, { centerElement: true, timeout: 7_000 });
    await m.tapOn(VT);

    await m.scrollUntilVisible(`.*Attributes for ${VT}.*`, { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible(m.id(`Rename ${VT}`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Rename ${VT}`));
    await m.waitVisible(m.id(`Edit name for ${VT}`), 7_000);
    await m.tapOn(m.id(`Edit name for ${VT}`)); // waitToSettleTimeoutMs dropped
    await m.inputText(VTX);
    await m.pressKey("Enter");

    await m.scrollUntilVisible(`.*Attributes for ${VTX}.*`, { centerElement: true, timeout: 7_000 });
    await m.assertNotVisible(VT);
  },
);
