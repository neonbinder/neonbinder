// Port of .maestro/flows/set-selector/move-parallels-of-inserts-custom.yaml
import { test } from "../../support/fixtures";
import type { Maestro } from "../../support/maestro";
import { utilDrillToCustomSet } from "../../support/subflows/set-selector/util-drill-to-custom-set";

/** One "<ID> <name>" custom insert: scroll to the add button, open the form, type, Enter, confirm. */
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
  "Move parallels-of-inserts — suggestions pre-placed on open, Accept All clears badges, Save persists nesting",
  { tag: ["@parallel-grouping", "@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustomSet(m, {
      SET_NAME: `pg-move-${env.WORKER_INDEX}`,
      VARIANT_TYPE: "Insert",
    });

    // ── ADD THREE CUSTOM INSERTS
    await m.waitVisible(m.id("Add custom Inserts"), 7_000);
    await addInsert(m, `${env.ATTEMPT_ID} Stars`);
    await addInsert(m, `${env.ATTEMPT_ID} Stars Gold`);
    await addInsert(m, `${env.ATTEMPT_ID} Stars Red`);

    // ── OPEN MODAL
    await m.scrollUntilVisible("Group Parallels", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Group Parallels");
    await m.assertVisible(".*Drag inserts under a parent.*");

    await m.assertVisible(".*Accept all suggestions.*");
    await m.assertVisible(".*[0-9]+ promotion.*");
    await m.assertVisible(".*Save [0-9]+ change.*");

    // ── ACCEPT ALL
    await m.scrollUntilVisible(".*Accept all suggestions.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Accept all suggestions.*");
    await m.assertNotVisible("Suggested");
    await m.assertVisible(".*[0-9]+ promotion.*");
    await m.assertVisible(".*Save [0-9]+ change.*");

    // ── SAVE (R8 exception: uncentred)
    await m.scrollUntilVisible(".*Save [0-9]+ change.*", { timeout: 7_000 });
    await m.tapOn(".*Save [0-9]+ change.*");
    await m.waitNotVisible(".*Drag inserts under a parent.*", 7_000);

    // ── VERIFY POST-SAVE STATE IN THE REAL COLUMNS
    await m.openLink("/dashboard");
    await m.waitVisible("COMING SOON", 20_000);
    await m.openLink("/set-selector");
    await m.waitVisible("Baseball", 60_000);

    await utilDrillToCustomSet(m, {
      SET_NAME: `pg-move-${env.WORKER_INDEX}`,
      VARIANT_TYPE: "Insert",
    });

    await m.assertNotVisible(`.*${env.ATTEMPT_ID} Stars Gold.*`);
    await m.assertNotVisible(`.*${env.ATTEMPT_ID} Stars Red.*`);

    await m.tapOn(m.id("Search inserts"));
    await m.inputText(`${env.ATTEMPT_ID} Stars`);
    await m.waitVisible(m.below(`.*${env.ATTEMPT_ID} Stars$`, m.id("Search inserts")), 7_000);
    await m.tapOn(m.below(`.*${env.ATTEMPT_ID} Stars$`, m.id("Search inserts")));
    await m.waitVisible("Parallels", 7_000);

    await m.waitVisible(`.*${env.ATTEMPT_ID} Stars Gold.*`, 7_000);
    await m.assertVisible(`.*${env.ATTEMPT_ID} Stars Red.*`);
  },
);
