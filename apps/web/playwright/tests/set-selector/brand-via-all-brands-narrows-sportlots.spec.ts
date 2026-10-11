// Port of .maestro/flows/set-selector/brand-via-all-brands-narrows-sportlots.yaml
import { test } from "../../support/fixtures";
import type { Maestro, Relational } from "../../support/maestro";
import { mrx } from "../../support/maestro";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";
import { utilDrillToColdRealSet } from "../../support/subflows/set-selector/util-drill-to-cold-real-set";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

/** Maestro `{ id: X, text: T }` on an input: accessible name X whose value matches T. */
function idWithValue(m: Maestro, id: string, valuePattern: string): Relational {
  const re = mrx(valuePattern);
  return {
    kind: "relational",
    description: `id ${JSON.stringify(id)} with value ${JSON.stringify(valuePattern)}`,
    probe: async () => {
      const fields = m.id(id);
      const n = await fields.count();
      for (let i = 0; i < n; i++) {
        const v = await fields.nth(i).inputValue().catch(() => null);
        if (v !== null && re.test(v)) return fields.nth(i);
      }
      return null;
    },
  };
}

test(
  "A brand SportLots has no entry for links through All Brands by set-name prefix — the year-wide sync asks SportLots for every brand of the year, the brand's sets re-home from Unknown, and its SportLots list narrows to the prefix",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    const BRAND = "SPx";
    const YEAR = "1997";

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    // STEP 1
    await utilDrillToColdRealSet(m, { SPORT: "Hockey", YEAR, MANUFACTURER: "All Brands" });
    await m.waitVisible(m.id("Sets"), 15_000);

    const SL_PAUSED = utilPausedPlatforms(m);

    // STEP 2
    if (SL_PAUSED) {
      await m.scrollUntilVisible("SportLots skipped: no SportLots ids on this path.", { timeout: 7_000 });
    }
    if (!SL_PAUSED) {
      await m.scrollUntilVisible("Sync Sets", { timeout: 150_000 });
      await m.assertNotVisible("SportLots skipped: no SportLots ids on this path.");
    }

    // STEP 3
    await utilDrillToCustom(m, { SPORT: "Hockey", YEAR });
    await m.waitVisible(m.below("All Brands", m.id("Search manufacturers")), 7_000);
    await m.scrollUntilVisible(m.id("Add custom Manufacturers"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Manufacturers"));
    await m.waitVisible("Add Custom Entry", 7_000);
    await m.tapOn("Enter custom value...");
    await m.inputText(BRAND);
    await m.pressKey("Enter");
    await m.waitVisible(`Create manufacturer '${BRAND}' under Hockey › ${YEAR}\\?`, 7_000);

    await m.assertVisible(`Sets in Unknown whose names start with '${BRAND}' move here.`);

    await m.tapOn(m.id("Create manufacturer"));
    await m.waitNotVisible("Add Custom Entry", 7_000);

    // STEP 4
    await utilDrillToColdRealSet(m, { SPORT: "Hockey", YEAR, MANUFACTURER: "All Brands" });
    await m.waitVisible(m.id("Sets"), 15_000);
    await m.scrollUntilVisible(".*Search sets.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search sets.*");
    await m.inputText(BRAND);
    await m.retry(1, async () => {
      // Maestro's Java `(?i)` prefix is dropped: the driver's patterns are already case-insensitive.
      await m.tapOn(m.below(`${BRAND}( .*)?`, m.id("Search sets")));
      await m.waitVisible("Variant Types", 7_000);
    });

    await m.assertVisible(m.id(`Manufacturers: ${BRAND} — change`));

    await m.waitVisible("Base", 60_000);

    await m.retry(1, async () => {
      await m.tapOn("Base");
      await m.waitVisible("Select Base Set", 7_000);
    });
    await m.waitVisible("Confirm Base Set", 60_000);

    await m.assertVisible(m.id("BSC base candidate: .*"));

    if (!SL_PAUSED) {
      await m.assertVisible(m.id("SportLots base candidate: .*"));
      await m.assertNotVisible("Search SportLots sets...");
    }
    if (SL_PAUSED) {
      await m.assertVisible("SportLots returned no base set for .*");
      await m.assertNotVisible(m.id("SportLots base candidate: .*"));
    }

    await m.tapOn("Cancel");
    await m.assertVisible(".*Base mapping cancelled.*");
    await m.tapOn("Close");
    await m.waitNotVisible(".*Base mapping cancelled.*", 7_000);
    await m.assertVisible("Map Base Set");

    // STEP 5
    await utilDrillToColdRealSet(m, { SPORT: "Hockey", YEAR, MANUFACTURER: BRAND });
    await m.assertVisible("Sets");

    await m.scrollUntilVisible("[0-9]+ sets? moved out of Unknown", { timeout: 7_000 });

    await m.scrollUntilVisible(m.id("Edit attributes"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Edit attributes"));
    await m.assertVisible(m.id("Hide attributes"));
    await m.scrollUntilVisible(idWithValue(m, "Value for Brand", BRAND), { timeout: 7_000 });

    await m.scrollUntilVisible("SportLots has no brand for this — match its sets by name", { timeout: 7_000 });
    if (SL_PAUSED) {
      await m.scrollUntilVisible("This year has no SportLots link to go through", { timeout: 7_000 });
    }
  },
);
