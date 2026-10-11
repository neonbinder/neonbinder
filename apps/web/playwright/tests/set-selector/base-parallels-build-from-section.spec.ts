// Port of .maestro/flows/set-selector/base-parallels-build-from-section.yaml
import { test, expect } from "../../support/fixtures";
import { mrx } from "../../support/maestro";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";

test(
  "2024 Topps Chrome Parallel — Build the base set's parallels from Base, stop after one, and the copy's title names its parallel (NEO-321)",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    // STEP 1
    await utilDrillTo2024ToppsChrome(m);
    const PARALLELS_N = m.env.SL_PAUSED ? "[0-9]+" : "41";

    await m.scrollUntilVisible("Parallel", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Parallel");
    await m.scrollUntilVisible(`Build ${PARALLELS_N} parallels from Base`, { centerElement: true, timeout: 7_000 });
    await m.assertVisible("Parallels of Base");

    // STEP 2
    await m.tapOn(`Build ${PARALLELS_N} parallels from Base`);
    await m.waitVisible(
      `Replace the cards on [1-9][0-9]* of ${PARALLELS_N} parallels with fresh copies of Base.s\\?`,
      7_000,
    );
    await m.tapOn("Replace and build");

    // STEP 3
    await m.scrollUntilVisible("Stop after this one", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Stop after this one");
    await m.waitVisible(`Base parallels — stopped after 1 of ${PARALLELS_N}`, 7_000);

    const LINE = ".+ — (Built|Rebuilt) [1-9][0-9]* cards?(, .+)?";
    await m.scrollUntilVisible(LINE, { direction: "DOWN", timeout: 7_000 });
    const copied = await m.copyTextFrom(LINE);
    const BUILT = copied.split(" — ")[0].trim();
    const BUILT_RE = BUILT.replace(/[\^\[\]()*+?.|]/g, (c) => "\\" + c);

    // STEP 4
    await utilDrillTo2024ToppsChrome(m);
    await m.scrollUntilVisible("Parallel", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Parallel");
    await m.waitVisible(".*Search parallels.*", 7_000);
    await m.scrollUntilVisible(".*Search parallels.*", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search parallels.*");
    await m.inputText(BUILT);
    await m.waitVisible(m.below(`^${BUILT_RE}$`, m.id("Search parallels")), 7_000);
    await m.tapOn(m.below(`^${BUILT_RE}$`, m.id("Search parallels")));

    await m.scrollUntilVisible(`.*Attributes for ${BUILT_RE}.*`, { centerElement: true, timeout: 7_000 });

    // `index: -1` = the bottom-most match (Maestro sorts by y then x).
    await m.scrollUntilVisible(m.id("Edit card .+").last(), { centerElement: true, timeout: 7_000 });
    await m.retry(1, async () => {
      await m.tapOn(m.id("Edit card .+").last());
      await m.waitVisible(m.id("Card title"), 7_000);
    });

    // assertVisible: id "Card title" + text (the input's value)
    const title = await m.resolve(m.id("Card title"), 7_000);
    await expect(title).toHaveValue(mrx(`.*${BUILT_RE}.*`), { timeout: 7_000 });
  },
);
