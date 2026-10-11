// Port of .maestro/flows/set-selector/reconcile-sportlots-twins-save-each-to-its-own-set.yaml
//
// PORT-GAP (whole file): Maestro's `swipe` here is a TOUCH drag that scrolls
// the Reconcile dialog's own body (a `fixed inset-0` portal). The driver's
// swipe() scrolls the WINDOW, so each swipe below is ported (same coordinates,
// same count, same cost) but does not move the dialog body. Playwright's
// actionability scroll brings every tapped control into view regardless, so
// the swipes are positioning only here; they are kept for 1:1 step timing.
import { test } from "../../support/fixtures";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";
import { utilAttachPaneSportlotsTwinIds } from "../../support/subflows/set-selector/util-attach-pane-sportlots-twin-ids";

test(
  "Reconcile — two SportLots sets with one name are each saved to their own NeonBinder set and stay linked by id through a re-sync (NEO-325, 2024 Topps City Connect)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const TWIN = "City Connect Swatch Collection";
    const S1_ID = "299607";
    const S2_ID = "307437";

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    // STEP 1 — Baseball → 2024 → Topps → Topps (the flagship)
    await utilDrillTo2024ToppsChrome(m, { SET: "Topps" });

    await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 7_000 });

    if (env.SL_PAUSED) {
      await m.assertVisible("Variant Types");
    }

    if (!env.SL_PAUSED) {
      await m.tapOn("Insert");
      // R5 marketplace exception — a COLD insert-level BSC + SportLots fetch.
      await m.waitVisible("Reconcile Inserts", 240_000);

      // STEP 2 — narrow the three lists, and the precondition
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });

      await m.tapOn(m.id("Filter NeonBinder sets"));
      await m.inputText("Swatch Collection Relics (Series");
      await m.waitVisible(".*Ready \\(0 of [0-9]+\\).*", 7_000);
      await m.tapOn(m.id("Clear filter neonbinder sets"));
      await m.inputText("Swatch Collection Relics (Series Two)");
      await m.waitVisible(".*Ready \\(0 of [0-9]+\\).*", 7_000);

      await m.tapOn(m.id("Filter BSC items"));
      await m.inputText("Swatch Collection Relics (Series");
      await m.waitVisible(".*BSC \\(2 of [0-9]+\\).*", 7_000);

      await m.tapOn(m.id("Show all SportLots items"));
      await m.tapOn(m.id("Search SportLots items"));
      await m.inputText(TWIN);
      await m.waitVisible(m.id(`Make its own set: ${TWIN} \\(#${S1_ID}\\)`), 7_000);
      await m.assertVisible(m.id(`Make its own set: ${TWIN} \\(#${S2_ID}\\)`));

      await m.swipe({ start: "3%, 75%", end: "3%, 50%" });

      // STEP 3 — pair Series One with 299607
      await m.tapOn("City Connect Swatch Collection Relics \\(Series One\\)");
      await m.tapOn(`\\(#${S1_ID}\\)`);
      await m.waitVisible(".*BSC \\(1 of [0-9]+\\).*", 7_000);
      await m.assertVisible(m.id(`Make its own set: ${TWIN} \\(#${S2_ID}\\)`));
      await m.assertNotVisible(m.id(`Make its own set: ${TWIN} \\(#${S1_ID}\\)`));

      // STEP 4 — pair Series Two with 307437
      await m.tapOn("City Connect Swatch Collection Relics \\(Series Two\\)");
      await m.tapOn(`\\(#${S2_ID}\\)`);
      await m.waitVisible(".*BSC \\(0 of [0-9]+\\).*", 7_000);
      await m.assertNotVisible(m.id(`Make its own set: ${TWIN} \\(#[0-9]+\\)`));

      // STEP 5 — claim 1: each set holds the twin that was pressed
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.tapOn(m.id("Clear filter neonbinder sets"));
      await m.inputText("Swatch Collection Relics (Series");
      await m.waitVisible(".*Ready \\(2 of [0-9]+\\).*", 7_000);
      await m.assertVisible(
        m.id(`Remove ${TWIN} \\(#${S1_ID}\\) from City Connect Swatch Collection Relics \\(Series One\\)`),
      );
      await m.assertVisible(
        m.id(`Remove ${TWIN} \\(#${S2_ID}\\) from City Connect Swatch Collection Relics \\(Series Two\\)`),
      );
      await m.assertNotVisible(".*so you can tell them apart\\..*");

      // STEP 6 — save
      await m.scrollUntilVisible(".*Save [0-9]+ sets.*", { timeout: 7_000 });
      await m.tapOn(".*Save [0-9]+ sets.*");
      await m.waitNotVisible("Reconcile Inserts", 7_000);

      // STEP 7 — claim 2: each saved row holds its own twin, and only it
      await utilAttachPaneSportlotsTwinIds(m, {
        SET: "Topps",
        INSERT_QUERY: "Swatch Collection Relics (Series One)",
        INSERT_ROW: "City Connect Swatch Collection Relics \\(Series One\\)",
        TWIN,
        ATTACHED_ID: S1_ID,
        OTHER_ID: S2_ID,
      });
      await utilAttachPaneSportlotsTwinIds(m, {
        SET: "Topps",
        INSERT_QUERY: "Swatch Collection Relics (Series Two)",
        INSERT_ROW: "City Connect Swatch Collection Relics \\(Series Two\\)",
        TWIN,
        ATTACHED_ID: S2_ID,
        OTHER_ID: S1_ID,
      });

      // STEP 8 — claim 3: a re-sync keeps each row on its own twin
      await utilDrillTo2024ToppsChrome(m, { SET: "Topps" });
      await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Insert");
      await m.scrollUntilVisible("Sync Inserts", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Sync Inserts");
      await m.waitVisible("Reconcile Inserts", 240_000);

      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.tapOn(m.id("Filter NeonBinder sets"));
      await m.inputText("Swatch Collection Relics (Series");
      await m.waitVisible(".*Ready \\(2 of [0-9]+\\).*", 7_000);
      await m.assertVisible(
        m.id(`Remove ${TWIN} \\(#${S1_ID}\\) from City Connect Swatch Collection Relics \\(Series One\\)`),
      );
      await m.assertVisible(
        m.id(`Remove ${TWIN} \\(#${S2_ID}\\) from City Connect Swatch Collection Relics \\(Series Two\\)`),
      );

      await m.tapOn(m.id("Clear filter neonbinder sets"));
      await m.inputText("Swatch Collection Relics (Series Three)");
      await m.waitVisible(".*Ready \\(0 of [0-9]+\\).*", 7_000);
      await m.tapOn(m.id("Show all SportLots items"));
      await m.tapOn(m.id("Search SportLots items"));
      await m.inputText(TWIN);
      await m.waitVisible(m.id(`Make its own set: ${TWIN} .+ \\(#[0-9]+\\)`), 7_000);
      await m.assertNotVisible(m.id(`Make its own set: ${TWIN} \\(#[0-9]+\\)`));

      await m.assertNotVisible(".*so you can tell them apart\\..*");
      await m.scrollUntilVisible(".*Save [0-9]+ sets.*", { timeout: 7_000 });
      await m.tapOn(".*Save [0-9]+ sets.*");
      await m.waitNotVisible("Reconcile Inserts", 7_000);

      // STEP 9 — claim 3: the re-sync made no row
      await utilDrillTo2024ToppsChrome(m, { SET: "Topps" });
      await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Insert");
      await m.scrollUntilVisible(".*Search inserts.*", { centerElement: true, timeout: 7_000 });
      await m.tapOn(".*Search inserts.*");
      await m.inputText("City Connect Swatch");
      await m.waitVisible(
        m.below("City Connect Swatch Collection Relics \\(Series One\\)", m.id("Search inserts")),
        7_000,
      );
      await m.assertVisible(
        m.below("City Connect Swatch Collection Relics \\(Series Two\\)", m.id("Search inserts")),
      );
      // A second match of either title is a duplicate row (`index: 1`). The
      // `below:` anchor is dropped for the nth locator: nothing above the
      // search box can match a full-text row title.
      await m.assertNotVisible(m.text("City Connect Swatch Collection Relics \\(Series One\\)").nth(1));
      await m.assertNotVisible(m.text("City Connect Swatch Collection Relics \\(Series Two\\)").nth(1));
      await m.assertNotVisible(m.below(TWIN, m.id("Search inserts")));

      // STEP 10 — claim 3: after the re-sync, each row still holds its own twin
      await utilAttachPaneSportlotsTwinIds(m, {
        SET: "Topps",
        INSERT_QUERY: "Swatch Collection Relics (Series One)",
        INSERT_ROW: "City Connect Swatch Collection Relics \\(Series One\\)",
        TWIN,
        ATTACHED_ID: S1_ID,
        OTHER_ID: S2_ID,
      });
      await utilAttachPaneSportlotsTwinIds(m, {
        SET: "Topps",
        INSERT_QUERY: "Swatch Collection Relics (Series Two)",
        INSERT_ROW: "City Connect Swatch Collection Relics \\(Series Two\\)",
        TWIN,
        ATTACHED_ID: S2_ID,
        OTHER_ID: S1_ID,
      });
    }
  },
);
