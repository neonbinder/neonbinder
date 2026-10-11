// Port of .maestro/flows/set-selector/multi-source-panel-opens-dialog.yaml
import { test } from "../../support/fixtures";
import { utilDrillToBaseVariant } from "../../support/subflows/set-selector/util-drill-to-base-variant";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

test(
  "Multi-source sets panel — Attach more dialog opens and cancels",
  { tag: ["@set-selector", "@neo-6"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToBaseVariant(m);
    utilPausedPlatforms(m);

    await m.scrollUntilVisible("Multi-source sets", {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });

    await m.waitVisible(m.id("Attach more source sets"), 5_000);
    await m.tapOn(m.id("Attach more source sets"));

    await m.waitVisible(m.id("Search BSC sets"), 7_000);

    await m.tapOn(m.id("Search BSC sets"));
    await m.inputText("Chrome");

    await m.waitVisible(".*Chrome.*", 7_000);

    if (!env.SL_PAUSED) {
      await m.waitVisible(m.within(m.id("SportLots candidates"), "id: [0-9]+"), 30_000);
    }
    if (env.SL_PAUSED) {
      await m.assertVisible(m.id("SportLots candidates"));
    }

    await m.scrollUntilVisible("Cancel", { timeout: 7_000 });
    await m.tapOn("Cancel");

    await m.waitNotVisible(m.id("Search BSC sets"), 10_000);

    await m.assertVisible("Multi-source sets");
  },
);
