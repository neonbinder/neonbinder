// Port of .maestro/flows/set-selector/base-mapping-cancel-recovers.yaml
import { test } from "../../support/fixtures";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";

test(
  "Base-set picker Cancel recovers — message + working Retry, no dead-end (NEO-71-74)",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    const SL_PAUSED = utilPausedPlatforms(m);

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillTo2024ToppsChrome(m, { SET: "Topps 206" });

    await m.scrollUntilVisible("Base", { centerElement: true, timeout: 7_000 });
    await m.retry(1, async () => {
      await m.tapOn("Base");
      await m.waitVisible("Select Base Set", 7_000);
    });

    await m.waitVisible("Confirm Base Set", 60_000);
    if (!SL_PAUSED) {
      await m.assertVisible(".*SportLots base.*");
    } else {
      await m.assertVisible("SportLots returned no base set for .*");
      await m.assertVisible(m.id("BSC base candidate: .*"));
      await m.assertNotVisible(m.id("SportLots base candidate: .*"));
    }

    await m.tapOn("Cancel");

    await m.scrollUntilVisible(".*Base mapping cancelled.*", { centerElement: true, timeout: 7_000 });
    await m.assertNotVisible("Confirm Base Set");
    await m.assertVisible("Retry");

    await m.retry(1, async () => {
      await m.tapOn("Retry");
      await m.waitVisible("Select Base Set", 7_000);
    });
    await m.waitVisible("Confirm Base Set", 60_000);
    if (!SL_PAUSED) {
      await m.assertVisible(".*SportLots base.*");
    } else {
      await m.assertVisible("SportLots returned no base set for .*");
      await m.assertVisible(m.id("BSC base candidate: .*"));
      await m.assertNotVisible(m.id("SportLots base candidate: .*"));
    }
  },
);
