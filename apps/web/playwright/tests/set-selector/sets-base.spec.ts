// Port of .maestro/flows/set-selector/sets-base.yaml — live BSC + SportLots
// base-set candidates for 2024 Topps Heritage (not pre-mapped by the seed).
import { test } from "../../support/fixtures";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";

test(
  "BaseSetPicker — confirm SportLots base-set mapping for 2024 Topps Heritage",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    const SL_PAUSED = utilPausedPlatforms(m);
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilDrillTo2024ToppsChrome(m, { SET: "Topps Heritage" });
    await m.scrollUntilVisible("Base", { centerElement: true, timeout: 7_000 });
    await m.retry(1, async () => {
      await m.tapOn("Base");
      await m.scrollUntilVisible(".*Select Base Set.*|.*Re-map Base.*", { centerElement: true, timeout: 7_000 });
    });

    if (!SL_PAUSED) {
      if (await m.isVisible("Select Base Set")) {
        await m.assertVisible(".*Choose the SportLots and BSC sets.*");
        await m.assertVisible(".*SportLots base.*");
        await m.assertVisible(".*BSC base.*");
        await m.assertVisible("likely match");
        await m.tapOn(m.id("BSC base candidate: .*"));
        await m.tapOn(m.id("SportLots base candidate: .*"));
        await m.scrollUntilVisible("Confirm Base Set", { timeout: 7_000 });
        await m.tapOn("Confirm Base Set");
        await m.waitNotVisible("Select Base Set"); // flow states no timeout
      }
      if (await m.isNotVisible("Select Base Set")) {
        await m.scrollUntilVisible("Re-map Base", { centerElement: true, timeout: 7_000 });
      }
      await m.scrollUntilVisible(".*Fetch from Marketplaces.*|Refresh", { timeout: 7_000 });
      await m.scrollUntilVisible("Re-map Base", { direction: "UP", timeout: 7_000 });
    } else {
      await m.waitVisible("Select Base Set", 7_000);
      await m.assertVisible(".*Choose the SportLots and BSC sets.*");
      await m.assertVisible(".*SportLots base.*");
      await m.assertVisible(".*BSC base.*");
      await m.waitVisible("Confirm Base Set", 45_000);
      await m.assertVisible("SportLots returned no base set for .*");
      await m.assertVisible(m.id("BSC base candidate: .*"));
      await m.assertNotVisible(m.id("SportLots base candidate: .*"));
      await m.tapOn(m.id("BSC base candidate: .*"));
      await m.scrollUntilVisible("Confirm Base Set", { timeout: 7_000 });
      await m.tapOn("Confirm Base Set");
      await m.waitNotVisible("Select Base Set", 7_000);
      await m.scrollUntilVisible(".*Fetch from Marketplaces.*|Refresh", { timeout: 7_000 });
      await m.assertNotVisible("Select Base Set");
    }
  },
);
