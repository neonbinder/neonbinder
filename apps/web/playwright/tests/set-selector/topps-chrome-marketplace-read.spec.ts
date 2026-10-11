// Port of .maestro/flows/set-selector/topps-chrome-marketplace-read.yaml
import { test } from "../../support/fixtures";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";

test(
  "Topps Chrome — read-only verify marketplace-derived set attributes are present (read-only)",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillTo2024ToppsChrome(m);

    await m.scrollUntilVisible(m.id("Edit attributes"), { centerElement: true, timeout: 7_000 });
    if (await m.isVisible(m.id("Edit attributes"))) {
      await m.tapOn(m.id("Edit attributes"));
      await m.waitVisible(m.id("Hide attributes"), 5_000);
    }
    await m.assertVisible(m.id("Hide attributes"));

    await m.assertVisible(".*›.*Topps Chrome.*");

    await m.scrollUntilVisible(m.id("Value for League"), { timeout: 7_000 });
    await m.scrollUntilVisible(".*Total Cards.*|.*Block.*", { timeout: 7_000 });
  },
);
