/**
 * Port of .maestro/flows/set-selector/util-drill-to-2024-topps-chrome.yaml —
 * drill to a (Sport, Year, Manufacturer, Set). Env overrides become options.
 */
import type { Maestro } from "../../maestro";

export interface DrillOptions {
  SPORT?: string;
  YEAR?: string;
  MANUFACTURER?: string;
  SET?: string;
  /** Paused-branch only: create the manufacturer via "+ Custom" if it is absent. */
  CREATE_MANUFACTURER?: boolean;
}

export async function utilDrillTo2024ToppsChrome(m: Maestro, o: DrillOptions = {}): Promise<void> {
  const SPORT = o.SPORT ?? "Baseball";
  const YEAR = o.YEAR ?? "2024";
  const MANUFACTURER = o.MANUFACTURER ?? "Topps";
  const SET = o.SET ?? "Topps Chrome";

  await m.openLink("/set-selector");
  await m.waitVisible(".*Build set parameters using marketplace APIs.*", 20_000);
  await m.waitVisible(SPORT, 7_000);
  await m.scrollUntilVisible(SPORT, { centerElement: true, timeout: 7_000 });
  await m.retry(1, async () => {
    await m.tapOn(SPORT);
    await m.waitVisible("Years", 7_000);
  });

  await m.waitVisible(".*Search years.*", 7_000);
  await m.tapOn(".*Search years.*");
  await m.inputText(YEAR);
  await m.retry(1, async () => {
    await m.tapOn(m.below(YEAR, m.id("Search years")));
    await m.waitVisible("Manufacturers", 7_000);
  });

  if (!m.env.SL_PAUSED) {
    await m.waitVisible(".*Search manufacturers.*", 7_000);
    await m.tapOn(".*Search manufacturers.*");
    await m.inputText(MANUFACTURER);
    await m.retry(1, async () => {
      await m.tapOn(m.below(MANUFACTURER, m.id("Search manufacturers")));
      await m.waitVisible("Sets", 7_000);
    });
  } else {
    if (await m.isVisible("Syncing Manufacturer Options")) {
      await m.waitNotVisible("Syncing Manufacturer Options", 7_000);
    }
    await m.waitVisible(
      `No manufacturers available. Sync from marketplaces to populate.|${MANUFACTURER}`,
      7_000,
    );
    if (o.CREATE_MANUFACTURER) {
      if (await m.isNotVisible(m.below(MANUFACTURER, "Manufacturers"))) {
        await m.scrollUntilVisible(m.id("Add custom Manufacturers"), { centerElement: true, timeout: 7_000 });
        await m.tapOn(m.id("Add custom Manufacturers"));
        await m.waitVisible("Add Custom Entry", 7_000);
        await m.tapOn("Enter custom value...");
        await m.inputText(MANUFACTURER);
        await m.pressKey("Enter");
        await m.waitVisible(m.id("Create manufacturer"), 7_000);
        await m.tapOn(m.id("Create manufacturer"));
        await m.waitNotVisible("Add Custom Entry", 7_000);
        await m.scrollUntilVisible(m.below(MANUFACTURER, "Manufacturers"), {
          direction: "UP",
          centerElement: true,
          timeout: 7_000,
        });
      }
    }
    await m.scrollUntilVisible(m.below(MANUFACTURER, "Manufacturers"), { centerElement: true, timeout: 7_000 });
    await m.retry(1, async () => {
      await m.tapOn(m.below(MANUFACTURER, "Manufacturers"));
      await m.waitVisible("Sets", 7_000);
    });
  }

  await m.tapOn(".*Search sets.*");
  await m.inputText(SET);
  await m.retry(1, async () => {
    await m.tapOn(m.below(SET, m.id("Search sets")));
    await m.waitVisible("Variant Types", 7_000);
  });
  // Variant Types may sync live on a cold set (flow's own 60 s).
  await m.waitVisible("Base", 60_000);
}
