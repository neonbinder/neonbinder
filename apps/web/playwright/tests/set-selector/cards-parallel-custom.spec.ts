// Port of .maestro/flows/set-selector/cards-parallel-custom.yaml
import { test } from "../../support/fixtures";
import { utilDrillToCustomSet } from "../../support/subflows/set-selector/util-drill-to-custom-set";

test(
  "Add custom Parallel — a hand-added parallel appears in the Parallels column and is selectable",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustomSet(m, {
      SET_NAME: `parallel-feature-${env.WORKER_INDEX}`,
      VARIANT_TYPE: "Parallel",
    });

    await m.scrollUntilVisible(m.id("Add custom Parallels"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Parallels"));
    await m.assertVisible("Add Custom Entry");
    await m.inputText("Prizm Gold");
    await m.pressKey("Enter");
    if (await m.isVisible(m.id("Create insert"))) {
      await m.tapOn(m.id("Create insert"));
    }
    await m.assertNotVisible("Add Custom Entry");

    await m.assertVisible(".*Prizm Gold.*");

    await m.scrollUntilVisible(".*Prizm Gold.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Prizm Gold.*");

    await m.scrollUntilVisible(".*Fetch from Marketplaces.*|Refresh", { timeout: 7_000 });
    await m.assertVisible("No cards in this checklist yet.");
  },
);
