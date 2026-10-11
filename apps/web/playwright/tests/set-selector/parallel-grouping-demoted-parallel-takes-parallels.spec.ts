// Port of .maestro/flows/set-selector/parallel-grouping-demoted-parallel-takes-parallels.yaml
import { test } from "../../support/fixtures";
import type { Maestro } from "../../support/maestro";
import { utilDrillToCustomSet } from "../../support/subflows/set-selector/util-drill-to-custom-set";

/** One custom insert: scroll to the add button, open the form, type, Enter, confirm if offered. */
async function addInsert(m: Maestro, name: string): Promise<void> {
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

test(
  "Group Parallels — a saved parallel sent back to the top level takes a parallel of its own in the same save (NEO-300)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ m, env }) => {
    const ID = env.ATTEMPT_ID;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustomSet(m, {
      SET_NAME: `pg-demote-${env.WORKER_INDEX}-${ID}`,
      VARIANT_TYPE: "Insert",
    });

    // STEP 1 — three inserts
    await addInsert(m, `${ID} Stars`);
    await addInsert(m, `${ID} Stars Gold`);
    await addInsert(m, `${ID} Stars Blue`);
    await m.waitVisible(`${ID} Stars Blue`, 7_000);

    // STEP 2 — make Gold and Blue saved parallels of Stars
    await m.scrollUntilVisible("Group Parallels", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Group Parallels");
    await m.waitVisible(".*Drag inserts under a parent.*", 7_000);
    await m.tapOn("Accept all suggestions \\(2\\)");
    await m.assertVisible("2 promotions, 0 demotions");
    await m.tapOn("Save 2 changes");
    await m.waitNotVisible(".*Drag inserts under a parent.*", 7_000);

    // STEP 3 — re-open: Gold is a saved parallel with no box of its own
    await m.scrollUntilVisible("Group Parallels", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn("Group Parallels");
    await m.waitVisible(".*Drag inserts under a parent.*", 7_000);
    await m.assertVisible("No changes yet");
    await m.assertVisible(m.id(`Remove ${ID} Stars Gold from parallels`));
    await m.assertNotVisible(`Parallels of "${ID} Stars Gold"`);

    // STEP 4 — remove Gold: it goes to the top level and gets its own box
    // PORT-GAP: Maestro's swipe is a real touch drag that scrolls the modal
    // body; the driver's swipe() scrolls the window. The modal is shorter than
    // its cap at this point (the flow's own comment), so the pin is a no-op.
    await m.swipe({ start: "13%, 75%", end: "13%, 25%" });
    await m.tapOn(m.id(`Remove ${ID} Stars Gold from parallels`));
    await m.waitVisible(`Parallels of "${ID} Stars Gold"`, 7_000);
    await m.assertVisible("0 promotions, 1 demotion");

    // STEP 5 — move Blue under Gold, which is being demoted in this same save
    await m.swipe({ start: "13%, 75%", end: "13%, 25%" }); // PORT-GAP: see STEP 4
    await m.tapOn(`${ID} Stars Blue`);
    await m.waitVisible("Click here to make the selected row a parallel", 7_000);
    await m.tapOn(`Parallels of "${ID} Stars Gold"`);
    await m.waitVisible("0 promotions, 1 demotion, 1 re-parented", 7_000);

    await m.tapOn("Save 2 changes");
    await m.waitNotVisible(".*Drag inserts under a parent.*", 7_000);

    // STEP 6 — Gold is an insert, Blue is its parallel
    await m.scrollUntilVisible(`${ID} Stars Gold`, { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn(`${ID} Stars Gold`);
    await m.waitVisible("Parallels", 7_000);
    await m.waitVisible(`${ID} Stars Blue`, 7_000);
  },
);
