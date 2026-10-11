/**
 * Port of .maestro/flows/set-selector/util-drill-to-base-variant.yaml — drill
 * to the Base variant type and confirm the BaseSetPicker, leaving the
 * CardChecklist visible.
 */
import type { Maestro } from "../../maestro";
import { utilDrillTo2024ToppsChrome, type DrillOptions } from "./util-drill-to-2024-topps-chrome";

export async function utilDrillToBaseVariant(m: Maestro, o: DrillOptions = {}): Promise<void> {
  await utilDrillTo2024ToppsChrome(m, {
    SPORT: o.SPORT ?? "Baseball",
    YEAR: o.YEAR ?? "2024",
    MANUFACTURER: o.MANUFACTURER ?? "Topps",
    SET: o.SET ?? "Topps Chrome",
  });
  await m.scrollUntilVisible("Base", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Base");
  await m.assertNotVisible("An error occurred. Please refresh the page.");
  await m.scrollUntilVisible(".*Select Base Set.*|.*Re-map Base.*", { centerElement: true, timeout: 7_000 });

  if (!m.env.SL_PAUSED) {
    if (await m.isVisible("Select Base Set")) {
      await m.waitVisible("Confirm Base Set", 45_000);
      await m.tapOn(m.id("BSC base candidate: .*"));
      await m.tapOn(m.id("SportLots base candidate: .*"));
      await m.tapOn("Confirm Base Set");
      await m.waitNotVisible("Select Base Set", 10_000);
    }
  } else {
    if (await m.isVisible("Select Base Set")) {
      await m.waitVisible("Confirm Base Set", 45_000);
      await m.assertVisible("SportLots returned no base set for .*");
      await m.assertVisible(m.id("BSC base candidate: .*"));
      await m.assertNotVisible(m.id("SportLots base candidate: .*"));
      await m.tapOn("Cancel");
      await m.assertVisible(".*Base mapping cancelled.*");
      await m.scrollUntilVisible("Close", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Close");
      await m.waitNotVisible(".*Base mapping cancelled.*", 7_000);
      await m.assertVisible("Map Base Set");
    }
  }

  await m.scrollUntilVisible("Add Card", { centerElement: true, timeout: 7_000 });
  await m.assertVisible(".*Fetch from Marketplaces.*|Refresh");
}
