// Port of .maestro/flows/set-selector/set-rename-survives-resync-and-suggests-bsc-name.yaml
import { test } from "../../support/fixtures";
import { utilDrillToColdRealSet } from "../../support/subflows/set-selector/util-drill-to-cold-real-set";

test(
  "A renamed set survives a forced Sync Sets with its subtree, and BSC's own name comes back as a suggestion the operator can accept",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    // STEP 1
    await utilDrillToColdRealSet(m, { SPORT: "Hockey", YEAR: "2024", MANUFACTURER: "Topps" });

    // STEP 2
    await m.scrollUntilVisible(".*Search sets.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search sets.*");
    await m.inputText("C");
    await m.retry(1, async () => {
      await m.tapOn(m.below("Topps NHL Sticker Collection|TCG", m.id("Search sets")));
      await m.waitVisible("Variant Types", 20_000);
    });

    await m.waitVisible("Base", 60_000);

    // STEP 3
    if (await m.isNotVisible("TCG")) {
      await m.scrollUntilVisible(m.id("Rename Topps NHL Sticker Collection"), {
        centerElement: true,
        timeout: 7_000,
      });
      await m.tapOn(m.id("Rename Topps NHL Sticker Collection"));
      await m.waitVisible(m.id("Edit name for Topps NHL Sticker Collection"), 7_000);
      await m.tapOn(m.id("Edit name for Topps NHL Sticker Collection"));
      await m.inputText("TCG");
      await m.pressKey("Enter");
    }

    await m.scrollUntilVisible(".*Attributes for TCG.*", { centerElement: true, timeout: 7_000 });

    // STEP 4
    await m.scrollUntilVisible("Sync Sets", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn("Sync Sets");

    await m.waitVisible("1 name to check", 90_000);

    // STEP 5
    await m.scrollUntilVisible(".*Attributes for TCG.*", { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("Base", { direction: "UP", centerElement: true, timeout: 7_000 });

    // STEP 6
    await m.scrollUntilVisible("1 name to check", { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("1 name to check — review suggestions"));

    await m.waitVisible("Name Check — Sets", 7_000);
    await m.assertVisible('BSC calls it "Topps NHL Sticker Collection"');

    await m.tapOn(m.id('Take it — rename "TCG" to "Topps NHL Sticker Collection" \\(from BSC\\)'));

    await m.assertVisible("1 to take · 0 to keep");

    await m.tapOn(m.id("Apply decisions"));

    await m.waitVisible("1 renamed", 7_000);

    // STEP 7
    await m.scrollUntilVisible(".*Attributes for Topps NHL Sticker Collection.*", {
      centerElement: true,
      timeout: 7_000,
    });

    await m.assertNotVisible("TCG");
    await m.assertNotVisible("1 name to check");
  },
);
