// Port of .maestro/flows/set-selector/known-brand-files-set-and-operator-move-sticks.yaml
import { test } from "../../support/fixtures";
import { utilDrillToColdRealSet } from "../../support/subflows/set-selector/util-drill-to-cold-real-set";

test(
  "A set whose name matches NB's known-brands list is filed under a brand the sync creates for it — and an operator's move out of that brand outlives the next Sync Sets",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    // STEP 0 — the fixture
    const SPORT = "Baseball";
    const YEAR = "1990";
    const BRAND = "CMC";

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    // STEP 1
    await utilDrillToColdRealSet(m, { SPORT, YEAR, MANUFACTURER: "All Brands" });
    await m.waitVisible(m.id("Sets"), 15_000);

    // STEP 2
    await m.scrollUntilVisible(".*Search sets.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search sets.*");
    await m.inputText(BRAND);
    await m.retry(1, async () => {
      // Maestro's Java `(?i)` prefix is dropped: the driver's patterns are already case-insensitive.
      await m.tapOn(m.below(`${BRAND}( .*)?`, m.id("Search sets")));
      await m.waitVisible("Variant Types", 7_000);
    });

    await m.assertVisible(m.id(`Manufacturers: ${BRAND} — change`));

    await m.waitNotVisible("Syncing Variant Types", 60_000);
    await m.assertVisible("Variant Types");

    // STEP 3
    await m.scrollUntilVisible("Move to another brand", { centerElement: true, timeout: 7_000 });
    await m.assertVisible(m.id("Delete .*"));
    await m.tapOn("Move to another brand");

    await m.waitVisible("Move to which brand\\?", 7_000);
    await m.assertVisible(m.id(`Brands in ${YEAR}`));
    await m.assertNotVisible(m.id(`Move to ${BRAND}`));

    await m.scrollUntilVisible(m.id("Move to Unknown"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Move to Unknown"));

    await m.waitVisible('Move ".*" to Unknown\\?', 7_000);
    await m.assertVisible(
      "The set keeps its cards, its variants and its marketplace links — only the brand above it changes. Sync Sets will leave it where you put it.",
    );
    await m.tapOn("Yes, move it");

    await m.waitVisible("Moved to Unknown", 7_000);
    await m.scrollUntilVisible(`.*${YEAR} › Unknown › .*`, { direction: "UP", timeout: 7_000 });

    // STEP 4
    await utilDrillToColdRealSet(m, { SPORT, YEAR, MANUFACTURER: "All Brands" });
    await m.waitVisible(m.id("Sets"), 15_000);

    await m.scrollUntilVisible("Sync Sets", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Sync Sets");

    await m.waitVisible("Syncing Sets", 7_000);
    await m.waitVisible("Sync Sets", 150_000);

    await m.scrollUntilVisible(".*Search sets.*", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search sets.*");
    await m.inputText(BRAND);
    await m.retry(1, async () => {
      await m.tapOn(m.below(`${BRAND}( .*)?`, m.id("Search sets")));
      await m.waitVisible("Variant Types", 7_000);
    });

    await m.assertVisible(m.id("Manufacturers: Unknown — change"));
  },
);
