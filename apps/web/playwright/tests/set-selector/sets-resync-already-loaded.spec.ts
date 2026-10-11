// Port of .maestro/flows/set-selector/sets-resync-already-loaded.yaml
import { test } from "../../support/fixtures";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";

test(
  "Variant types persist across sessions; auto-sync guard skips re-sync when present",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await m.openLink("/profile/credentials");
    await m.assertVisible("Profile Settings");
    await utilDrillTo2024ToppsChrome(m);
    await m.scrollUntilVisible("Base", { centerElement: true, timeout: 7_000 });
    await m.assertVisible("Insert");
    await m.assertVisible("Parallel");
    await m.assertNotVisible("Syncing Variant Types");
    await m.scrollUntilVisible("Sync Variant Types", { timeout: 7_000 });
  },
);
