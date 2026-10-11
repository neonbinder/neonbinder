// Port of .maestro/flows/set-selector/parallel-grouping-multi-select-moves-together.yaml
import { test } from "../../support/fixtures";
import { utilDrillToCustomSet } from "../../support/subflows/set-selector/util-drill-to-custom-set";

test(
  "Group Parallels — two ticked rows move under one insert with a single press and a single Save (NEO-300)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilDrillToCustomSet(m, { SET_NAME: `pg-multi-${env.WORKER_INDEX}-${env.ATTEMPT_ID}`, VARIANT_TYPE: "Insert" });
    await m.scrollUntilVisible(m.id("Add custom Inserts"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Inserts"));
    await m.assertVisible("Add Custom Entry");
    await m.inputText(`${env.ATTEMPT_ID} Aces`);
    await m.pressKey("Enter");
    if (await m.isVisible(m.id("Create insert"))) {
      await m.tapOn(m.id("Create insert"));
    }
    await m.assertNotVisible("Add Custom Entry");
    await m.scrollUntilVisible(m.id("Add custom Inserts"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Inserts"));
    await m.assertVisible("Add Custom Entry");
    await m.inputText(`${env.ATTEMPT_ID} Bolt`);
    await m.pressKey("Enter");
    if (await m.isVisible(m.id("Create insert"))) {
      await m.tapOn(m.id("Create insert"));
    }
    await m.assertNotVisible("Add Custom Entry");
    await m.scrollUntilVisible(m.id("Add custom Inserts"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Inserts"));
    await m.assertVisible("Add Custom Entry");
    await m.inputText(`${env.ATTEMPT_ID} Comet`);
    await m.pressKey("Enter");
    if (await m.isVisible(m.id("Create insert"))) {
      await m.tapOn(m.id("Create insert"));
    }
    await m.assertNotVisible("Add Custom Entry");
    await m.waitVisible(`${env.ATTEMPT_ID} Comet`, 7_000);
    await m.scrollUntilVisible("Group Parallels", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Group Parallels");
    await m.waitVisible(".*Drag inserts under a parent.*", 7_000);
    await m.assertVisible("No changes yet");
    await m.tapOn(m.id(`Select ${env.ATTEMPT_ID} Bolt`));
    await m.tapOn(m.id(`Select ${env.ATTEMPT_ID} Comet`));
    await m.waitVisible("2 selected", 7_000);
    await m.assertVisible("Click here to make the 2 selected rows parallels");
    await m.tapOn(`Parallels of "${env.ATTEMPT_ID} Aces"`);
    await m.waitVisible("2 promotions, 0 demotions", 7_000);
    await m.tapOn("Save 2 changes");
    await m.waitNotVisible(".*Drag inserts under a parent.*", 7_000);
    await m.scrollUntilVisible(`${env.ATTEMPT_ID} Aces`, { centerElement: true, direction: "UP", timeout: 7_000 });
    await m.tapOn(`${env.ATTEMPT_ID} Aces`);
    await m.waitVisible("Parallels", 7_000);
    await m.waitVisible(`${env.ATTEMPT_ID} Bolt`, 7_000);
    await m.waitVisible(`${env.ATTEMPT_ID} Comet`, 7_000);
  },
);
