/**
 * Port of .maestro/flows/set-selector/util-drill-to-cold-real-set.yaml — drill
 * to a Sport -> Year -> Manufacturer that has never been synced, paying the
 * cold marketplace waits (R5's live-round-trip exception; numbers are the flow's).
 */
import type { Maestro } from "../../maestro";

export interface ColdDrillOptions {
  SPORT?: string;
  YEAR?: string;
  MANUFACTURER?: string;
}

export async function utilDrillToColdRealSet(m: Maestro, o: ColdDrillOptions = {}): Promise<void> {
  const SPORT = o.SPORT ?? "Hockey";
  const YEAR = o.YEAR ?? "2024";
  const MANUFACTURER = o.MANUFACTURER ?? "Topps";
  const PINNED_VIEW = MANUFACTURER === "All Brands";
  const SL_PAUSED = m.env.SL_PAUSED;

  await m.openLink("/set-selector");
  await m.waitVisible(".*Build set parameters using marketplace APIs.*", 20_000);
  await m.waitVisible(".*Search sports.*", 60_000);
  await m.scrollUntilVisible(".*Search sports.*", { centerElement: true, timeout: 7_000 });
  await m.tapOn(".*Search sports.*");
  await m.inputText(SPORT);
  await m.retry(1, async () => {
    await m.tapOn(m.below(SPORT, m.id("Search sports")));
    await m.waitVisible("Years", 20_000);
  });
  if (await m.isVisible("Syncing Year Options")) {
    await m.waitNotVisible("Syncing Year Options", 150_000);
  }
  await m.waitVisible(m.id("Years"), 60_000);
  await m.scrollUntilVisible(".*Search years.*", { centerElement: true, timeout: 7_000 });
  await m.tapOn(".*Search years.*");
  await m.inputText(YEAR);
  await m.retry(1, async () => {
    await m.tapOn(m.below(YEAR, m.id("Search years")));
    await m.waitVisible("Manufacturers", 20_000);
  });
  if (await m.isVisible("Syncing Manufacturer Options")) {
    await m.waitNotVisible("Syncing Manufacturer Options", 150_000);
  }

  if (PINNED_VIEW && !SL_PAUSED) {
    await m.waitVisible(m.below("All Brands", m.id("Search manufacturers")), 7_000);
    await m.waitNotVisible("No manufacturers available. Sync from marketplaces to populate.", 60_000);
  }
  if (PINNED_VIEW && SL_PAUSED) {
    await m.waitVisible("No manufacturers available. Sync from marketplaces to populate.|Unknown", 7_000);
  }
  if (PINNED_VIEW) {
    await m.scrollUntilVisible(m.below("All Brands", m.id("Search manufacturers")), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.retry(1, async () => {
      await m.tapOn(m.below("All Brands", m.id("Search manufacturers")));
      await m.waitVisible("Sets", 20_000);
    });
  }
  if (!SL_PAUSED && !PINNED_VIEW) {
    await m.scrollUntilVisible(".*Search manufacturers.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search manufacturers.*");
    await m.inputText(MANUFACTURER);
    await m.waitVisible(m.below(MANUFACTURER, m.id("Search manufacturers")), 60_000);
    await m.retry(1, async () => {
      await m.tapOn(m.below(MANUFACTURER, m.id("Search manufacturers")));
      await m.waitVisible("Sets", 20_000);
    });
  }
  if (SL_PAUSED && !PINNED_VIEW) {
    await m.waitVisible(`No manufacturers available. Sync from marketplaces to populate.|${MANUFACTURER}`, 7_000);
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
    }
    await m.scrollUntilVisible(m.below(MANUFACTURER, "Manufacturers"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.retry(1, async () => {
      await m.tapOn(m.below(MANUFACTURER, "Manufacturers"));
      await m.waitVisible("Sets", 20_000);
    });
  }
  if (await m.isVisible("Syncing Sets")) {
    await m.waitNotVisible("Syncing Sets", 150_000);
  }
}
