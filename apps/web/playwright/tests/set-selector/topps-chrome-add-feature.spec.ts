// Port of .maestro/flows/set-selector/topps-chrome-add-feature.yaml
import { test } from "../../support/fixtures";
import type { Maestro } from "../../support/maestro";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";

/** Open the attributes panel, tick/untick Reprint, wait for the save toast. */
async function toggleReprint(m: Maestro, assertHidePresent: boolean): Promise<void> {
  await m.scrollUntilVisible(m.id("Edit attributes"), { centerElement: true, timeout: 7_000 }); // visibilityPercentage dropped

  if (await m.isVisible(m.id("Edit attributes"))) {
    await m.tapOn(m.id("Edit attributes"));
    await m.waitVisible(m.id("Hide attributes"), 5_000);
  }
  if (assertHidePresent) await m.assertVisible(m.id("Hide attributes"));

  await m.scrollUntilVisible(m.id("Value for Reprint"), { centerElement: true, timeout: 7_000 });
  await m.tapOn(m.id("Value for Reprint"));
  await m.waitVisible(".*Saved Reprint.*", 7_000);
}

test(
  "Topps Chrome — toggle the Reprint checkbox feature via SetAttributesPanel and verify save toast + re-hydration across reload (sole-writer)",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillTo2024ToppsChrome(m);
    await toggleReprint(m, true);

    // Re-drill (reload), then toggle back to restore
    await utilDrillTo2024ToppsChrome(m);
    await toggleReprint(m, false);
  },
);
