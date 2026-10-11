// Port of .maestro/flows/set-selector/parallel-grouping-cancel-discards.yaml
import { test } from "../../support/fixtures";
import { utilDrillToCustomSet } from "../../support/subflows/set-selector/util-drill-to-custom-set";

test(
  "Parallel Grouping — Cancel discards changes (reopen shows original); also closes via backdrop",
  { tag: ["@parallel-grouping"] },
  async ({ m, env }) => {
    const ID = env.ATTEMPT_ID;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustomSet(m, {
      SET_NAME: `pg-cancel-${env.WORKER_INDEX}-${ID}`,
      VARIANT_TYPE: "Insert",
    });

    for (const name of [`${ID} Stars`, `${ID} Stars Gold`, `${ID} Stars Red`]) {
      await m.scrollUntilVisible(m.id("Add custom Inserts"), { centerElement: true, timeout: 7_000 });
      await m.tapOn(m.id("Add custom Inserts"));
      await m.assertVisible("Add Custom Entry");
      await m.inputText(name);
      await m.pressKey("Enter");
      if (await m.isVisible(m.id("Create insert"))) {
        await m.tapOn(m.id("Create insert"));
      }
      await m.assertNotVisible("Add Custom Entry");
    }

    await m.scrollUntilVisible("Group Parallels", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Group Parallels");
    await m.assertVisible(".*Drag inserts under a parent.*");
    await m.assertVisible("Top-level inserts");
    await m.assertVisible(".*Accept all suggestions.*");
    await m.scrollUntilVisible(".*Accept all suggestions.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Accept all suggestions.*");
    await m.assertVisible(".*[0-9]+ promotion.*");
    await m.assertVisible(`.*Parallels of.*${ID} Stars.*`);

    // Cancel, then confirm the discard.
    await m.tapOn("Cancel");
    await m.tapOn(m.below("Discard .*", ".*Nothing has been saved yet.*"));
    await m.assertNotVisible(".*Drag inserts under a parent.*");

    await m.scrollUntilVisible(m.id("Add custom Inserts"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    if (await m.isNotVisible("^Inserts$")) {
      await m.tapOn(m.above(`.*${ID} Stars.*`, m.id("Add custom Inserts")));
      await m.waitVisible("^Inserts$");
    }
    await m.assertVisible(`^${ID} Stars$`);
    await m.assertVisible(`${ID} Stars Gold`);
    await m.assertVisible(`${ID} Stars Red`);

    await m.scrollUntilVisible("Group Parallels", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Group Parallels");
    await m.assertVisible(".*Drag inserts under a parent.*");
    await m.assertVisible("Top-level inserts");
    await m.assertVisible(".*[0-9]+ promotion.*");
    await m.scrollUntilVisible("Suggested", { centerElement: true, timeout: 7_000 });
    await m.assertVisible(".*Save [0-9]+ change.*");

    await m.scrollUntilVisible(".*Accept all suggestions.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Accept all suggestions.*");
    await m.assertVisible(".*[0-9]+ promotion.*");
    await m.assertVisible(`.*Parallels of.*${ID} Stars.*`);

    // Close via the backdrop (a point left of the dialog), then confirm the discard.
    await m.tapPoint("2%, 50%");
    await m.tapOn(m.below("Discard .*", ".*Nothing has been saved yet.*"));
    await m.assertNotVisible(".*Drag inserts under a parent.*");

    await m.scrollUntilVisible("Group Parallels", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Group Parallels");
    await m.assertVisible(".*Drag inserts under a parent.*");

    await m.scrollUntilVisible("Suggested", { centerElement: true, timeout: 7_000 });
    await m.assertVisible(".*Save [0-9]+ change.*");

    await m.tapOn("Cancel");
    await m.tapOn(m.below("Discard .*", ".*Nothing has been saved yet.*"));
    await m.assertNotVisible(".*Drag inserts under a parent.*");

    await m.scrollUntilVisible(m.id("Add custom Inserts"), { centerElement: true, timeout: 7_000 });
    await m.assertVisible("Group Parallels");
  },
);
