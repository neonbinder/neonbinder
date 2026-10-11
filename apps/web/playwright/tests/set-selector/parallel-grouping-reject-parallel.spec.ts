// Port of .maestro/flows/set-selector/parallel-grouping-reject-parallel.yaml
import { test } from "../../support/fixtures";
import { utilDrillToCustomSet } from "../../support/subflows/set-selector/util-drill-to-custom-set";

test(
  "Parallel Grouping — reject (✕) button moves a parallel back to top-level inserts",
  { tag: ["@parallel-grouping"] },
  async ({ m, env }) => {
    const ID = env.ATTEMPT_ID;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustomSet(m, { SET_NAME: `pg-reject-${env.WORKER_INDEX}-${ID}`, VARIANT_TYPE: "Insert" });

    await m.waitVisible(m.id("Add custom Inserts"), 7_000);

    const addInsert = async (name: string) => {
      await m.scrollUntilVisible(m.id("Add custom Inserts"), { centerElement: true, timeout: 7_000 });
      await m.tapOn(m.id("Add custom Inserts"));
      await m.assertVisible("Add Custom Entry");
      await m.inputText(name);
      await m.pressKey("Enter");
      if (await m.isVisible(m.id("Create insert"))) {
        await m.tapOn(m.id("Create insert"));
      }
      await m.assertNotVisible("Add Custom Entry");
    };

    await addInsert(`${ID} Stars`);
    await addInsert(`${ID} Stars Gold`);
    await addInsert(`${ID} Champions`);
    await m.assertVisible(`.*${ID} Champions.*`);

    await m.scrollUntilVisible("Group Parallels", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Group Parallels");
    await m.assertVisible(".*Drag inserts under a parent.*");
    await m.assertVisible("Top-level inserts");
    await m.assertVisible(".*Accept all suggestions.*");

    await m.scrollUntilVisible(".*Accept all suggestions.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Accept all suggestions.*");
    await m.assertVisible(".*[0-9]+ promotion.*");
    await m.assertVisible(`.*Parallels of.*${ID} Stars.*`);

    await m.swipe({ start: "13%, 75%", end: "13%, 25%" });
    await m.tapOn(m.id(`Remove ${ID} Stars Gold from parallels`));

    await m.assertVisible("No changes yet");
    await m.assertVisible(`.*${ID} Stars Gold.*`);

    await m.tapOn("Cancel");
    await m.assertNotVisible(".*Drag inserts under a parent.*");
  },
);
