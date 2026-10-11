// Port of .maestro/flows/set-selector/bowman-sportlots-links-move-between-set-parallel-insert.yaml
import { test } from "../../support/fixtures";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";
import { utilDrillToColdRealSet } from "../../support/subflows/set-selector/util-drill-to-cold-real-set";

test(
  "2026 Bowman SportLots links — Blue pairs both links, Promote to set and Make parallel of move its SportLots link out and back, Make insert of files Red Ink (NEO-305/306)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ m }) => {
    const BRAND = "Bowman";
    const COLOUR = "Blue";
    const SL_SET = "Bowman Blue";
    const INSERT_ROW = "All-America Game Autos";
    const SOURCE_ROW = "All-America Game Autos Red Ink";
    const NEW_PARALLEL = "Red Ink";
    const TYPE_PARALLEL = "Parallel";
    const TYPE_INSERT = "Insert";

    const SL_PAUSED = utilPausedPlatforms(m);
    const drillBowman = { SPORT: "Baseball", YEAR: "2026", MANUFACTURER: BRAND, SET: BRAND };

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    // STEP 10
    await utilDrillTo2024ToppsChrome(m, drillBowman);

    await m.scrollUntilVisible(TYPE_PARALLEL, { centerElement: true, timeout: 7_000 });
    await m.tapOn(TYPE_PARALLEL);

    if (!SL_PAUSED) {
      await m.scrollUntilVisible(`Sync ${TYPE_PARALLEL}s`, { centerElement: true, timeout: 7_000 });
      await m.tapOn(`Sync ${TYPE_PARALLEL}s`);
      await m.waitVisible(`Reconcile ${TYPE_PARALLEL}s`, 240_000);
      await m.tapOn(m.id("Filter NeonBinder sets"));
      await m.inputText(COLOUR);
      await m.waitVisible(m.id(`NeonBinder set name for ${COLOUR}$`), 7_000);
      await m.assertVisible(m.id(`Remove ${COLOUR} from ${COLOUR}`).nth(1));
      await m.scrollUntilVisible(".*Save [0-9]+ sets.*", { timeout: 7_000 });
      await m.tapOn(".*Save [0-9]+ sets.*");
      await m.waitNotVisible(`Reconcile ${TYPE_PARALLEL}s`, 7_000);
    }

    if (SL_PAUSED) {
      await m.waitVisible(m.id(`${TYPE_PARALLEL}s`), 240_000);
      await m.assertNotVisible(`Reconcile ${TYPE_PARALLEL}s`);
    }
    await m.scrollUntilVisible(".*Search parallels.*", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search parallels.*");
    await m.inputText(COLOUR);
    await m.waitVisible(m.below(`^${COLOUR}$`, m.id("Search parallels")), 7_000);
    await m.tapOn(m.below(`^${COLOUR}$`, m.id("Search parallels")));

    await m.scrollUntilVisible(`.*Attributes for ${COLOUR}.*`, { centerElement: true, timeout: 7_000 });

    if (SL_PAUSED) {
      await m.assertNotVisible("Promote to set");
    }

    // STEP 11
    if (!SL_PAUSED) {
      await m.scrollUntilVisible("Promote to set", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Promote to set");
      await m.waitVisible(`Promote “${COLOUR}” to a set`, 7_000);
      await m.waitVisible(`.*“${COLOUR}” stays, keeping everything else on it\\.`, 7_000);
      await m.tapOn("Promote it");
      await m.waitVisible(`“${SL_SET}” is its own set now\\.`, 7_000);
    }

    // STEP 12
    if (!SL_PAUSED) {
      await utilDrillTo2024ToppsChrome(m, { ...drillBowman, SET: SL_SET });
      await m.scrollUntilVisible("Make parallel of…", { centerElement: true, timeout: 7_000 });
      await m.assertVisible(`.*Attributes for ${SL_SET}.*`);
      await m.tapOn("Make parallel of…");
      await m.waitVisible(`Make “${SL_SET}” a parallel`, 7_000);
      await m.waitVisible(`Parallel of: ${BRAND}`, 7_000);
      await m.waitVisible("joins", 7_000);
      await m.tapOn("Make it a parallel");
      await m.waitVisible(`“${SL_SET}” joined ${BRAND}.s “${COLOUR}” parallel\\.`, 7_000);
    }

    // STEP 13
    if (!SL_PAUSED) {
      await utilDrillToColdRealSet(m, { SPORT: "Baseball", YEAR: "2026", MANUFACTURER: BRAND });
      await m.scrollUntilVisible("Sync Sets", { timeout: 7_000 });
      await m.assertVisible("Bowman Chrome");
      await m.assertVisible("Bowman Sapphire Edition");
      await m.assertNotVisible(SL_SET);
    }

    // STEP 14
    if (!SL_PAUSED) {
      await utilDrillTo2024ToppsChrome(m, drillBowman);
      await m.scrollUntilVisible(TYPE_PARALLEL, { centerElement: true, timeout: 7_000 });
      await m.tapOn(TYPE_PARALLEL);
      await m.waitVisible(".*Search parallels.*", 7_000);
      await m.scrollUntilVisible(".*Search parallels.*", { centerElement: true, timeout: 7_000 });
      await m.tapOn(".*Search parallels.*");
      await m.inputText(SOURCE_ROW);
      await m.waitVisible(m.below(`^${SOURCE_ROW}$`, m.id("Search parallels")), 7_000);
      await m.tapOn(m.below(`^${SOURCE_ROW}$`, m.id("Search parallels")));
      await m.scrollUntilVisible(`.*Attributes for ${SOURCE_ROW}.*`, { centerElement: true, timeout: 7_000 });
      await m.scrollUntilVisible("Make insert of…", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Make insert of…");
      await m.waitVisible(`Make “${SOURCE_ROW}” (an insert|a parallel)`, 7_000);
      await m.waitVisible(`Insert of: ${BRAND}`, 7_000);
      await m.waitVisible("Where it goes", 7_000);
      await m.retry(1, async () => {
        if (await m.isVisible(m.id("Find an insert"))) {
          await m.tapOn(m.id("Find an insert"));
          await m.eraseText(30);
          await m.inputText(INSERT_ROW);
        }
        await m.waitVisible(m.id(`Add to ${INSERT_ROW}$`), 7_000);
        await m.tapOn(m.id(`Add to ${INSERT_ROW}$`));
        await m.waitVisible(`Where it goes: ${INSERT_ROW}`, 7_000);
      });
      await m.assertVisible(`Under ${INSERT_ROW} as`);
      await m.waitVisible(NEW_PARALLEL, 7_000);
      await m.assertVisible(`Make “${SOURCE_ROW}” a parallel`);
      await m.tapOn("Make it a parallel");
      await m.waitVisible(
        `“${SOURCE_ROW}” now lives at ${BRAND} › ${TYPE_INSERT} › ${INSERT_ROW} › ${NEW_PARALLEL}\\.`,
        7_000,
      );
      await m.scrollUntilVisible(`.*Attributes for ${NEW_PARALLEL}.*`, { centerElement: true, timeout: 7_000 });
    }

    // STEP 15
    await utilDrillTo2024ToppsChrome(m, drillBowman);
    await m.scrollUntilVisible(TYPE_PARALLEL, { centerElement: true, timeout: 7_000 });
    await m.tapOn(TYPE_PARALLEL);
    await m.scrollUntilVisible(`Sync ${TYPE_PARALLEL}s`, { centerElement: true, timeout: 7_000 });
    await m.tapOn(`Sync ${TYPE_PARALLEL}s`);

    if (!SL_PAUSED) {
      await m.waitVisible(`Reconcile ${TYPE_PARALLEL}s`, 240_000);
      await m.scrollUntilVisible(".*Save [0-9]+ sets.*", { timeout: 7_000 });
      await m.tapOn(".*Save [0-9]+ sets.*");
      await m.waitNotVisible(`Reconcile ${TYPE_PARALLEL}s`, 7_000);
    }

    if (SL_PAUSED) {
      await m.waitVisible(
        "Stored [0-9]+ variants \\(single platform\\)|Some variants were not stored.*|Sync failed: could not load variants.*",
        240_000,
      );
      await m.assertVisible("Stored [0-9]+ variants \\(single platform\\)");
      await m.assertNotVisible(`Reconcile ${TYPE_PARALLEL}s`);
    }

    await m.scrollUntilVisible(".*Search parallels.*", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search parallels.*");
    await m.inputText(SOURCE_ROW);
    await m.waitVisible(m.below("No matches found", m.id("Search parallels")), 7_000);
    await m.assertNotVisible(m.below(`^${SOURCE_ROW}$`, m.id("Search parallels")));

    // STEP 16
    if (!SL_PAUSED) {
      await utilDrillTo2024ToppsChrome(m, drillBowman);
      await m.scrollUntilVisible(TYPE_INSERT, { centerElement: true, timeout: 7_000 });
      await m.tapOn(TYPE_INSERT);
      await m.waitVisible(`.*Search inserts.*|^${INSERT_ROW}$`, 7_000);
      await m.retry(1, async () => {
        let INSERTS_SEARCHABLE = false;
        if (await m.isVisible(m.id("Search inserts"))) {
          INSERTS_SEARCHABLE = true;
        }
        if (INSERTS_SEARCHABLE) {
          await m.tapOn(m.id("Search inserts"));
          await m.eraseText(30);
          await m.inputText(INSERT_ROW);
          await m.waitVisible(m.below(`^${INSERT_ROW}$`, m.id("Search inserts")), 7_000);
          await m.tapOn(m.below(`^${INSERT_ROW}$`, m.id("Search inserts")));
        }
        if (!INSERTS_SEARCHABLE) {
          await m.tapOn(m.below(`^${INSERT_ROW}$`, "Inserts"));
        }
        await m.waitVisible("Parallels", 7_000);
      });
      await m.waitVisible(m.below(`^${NEW_PARALLEL}$`, "Parallels"), 7_000);
      await m.tapOn(m.below(`^${NEW_PARALLEL}$`, "Parallels"));
      await m.scrollUntilVisible("Multi-source sets", { centerElement: true, timeout: 7_000 });
      await m.scrollUntilVisible(m.id(`Remove .*${NEW_PARALLEL}`), {
        direction: "DOWN",
        centerElement: true,
        timeout: 7_000,
      });
      await m.tapOn(m.id(`Remove .*${NEW_PARALLEL}`));
      await m.waitVisible(`Detach SportLots ".*${NEW_PARALLEL}"\\? .*`, 7_000);
      await m.tapOn(m.id(`Cancel detach .*${NEW_PARALLEL}`));
      await m.waitNotVisible("Detach SportLots .*", 7_000);
      await m.assertVisible(m.id(`Remove .*${NEW_PARALLEL}`));
    }
  },
);
