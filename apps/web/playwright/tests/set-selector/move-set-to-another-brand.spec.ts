// Port of .maestro/flows/set-selector/move-set-to-another-brand.yaml
import { test } from "../../support/fixtures";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

test(
  "A set moves to another brand of its own year from the attributes panel — the current brand is not offered, Cancel moves nothing, and the set arrives under the brand the confirm named",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilDrillToCustom(m, { SPORT: `msb-sport-${env.WORKER_INDEX}`, YEAR: "2026", MANUFACTURER: "Panini" });
    await m.assertVisible("Sets");
    await utilDrillToCustom(m, { SPORT: `msb-sport-${env.WORKER_INDEX}`, YEAR: "2026", MANUFACTURER: "Topps", SET_NAME: `msb-a-${env.WORKER_INDEX}` });
    await m.assertVisible("Variant Types");
    await m.scrollUntilVisible("Move to another brand", { centerElement: true, timeout: 7_000 });
    await m.assertVisible(m.id(`Delete msb-a-${env.WORKER_INDEX}`));
    await m.assertVisible(`.*Attributes for msb-a-${env.WORKER_INDEX}.*`);
    await m.tapOn("Move to another brand");
    await m.waitVisible("Move to which brand\\?", 7_000);
    await m.assertVisible(m.id("Brands in 2026"));
    await m.assertVisible(m.id("Move to Panini"));
    await m.assertNotVisible(m.id("Move to Topps"));
    await m.scrollUntilVisible(m.id("Move to Panini"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Move to Panini"));
    await m.waitVisible(`Move "msb-a-${env.WORKER_INDEX}" to Panini\\?`, 7_000);
    await m.assertVisible("The set keeps its cards, its variants and its marketplace links — only the brand above it changes. Sync Sets will leave it where you put it.");
    await m.tapOn("Cancel");
    await m.waitNotVisible("Yes, move it", 7_000);
    await m.assertVisible("Move to which brand\\?");
    await m.scrollUntilVisible(`.*2026 › Topps › msb-a-${env.WORKER_INDEX}.*`, { direction: "UP", timeout: 7_000 });
    await m.scrollUntilVisible(m.id("Move to Panini"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Move to Panini"));
    await m.waitVisible("Yes, move it", 7_000);
    await m.tapOn("Yes, move it");
    await m.waitVisible("Moved to Panini", 7_000);
    await m.scrollUntilVisible(`.*2026 › Panini › msb-a-${env.WORKER_INDEX}.*`, { direction: "UP", timeout: 7_000 });
    await m.scrollUntilVisible(m.id("Manufacturers: Panini — change"), { direction: "UP", timeout: 7_000 });
    await m.assertVisible(m.id(`Sets: msb-a-${env.WORKER_INDEX} — change`));
    await utilDrillToCustom(m, { SPORT: `msb-sport-${env.WORKER_INDEX}`, YEAR: "2026", MANUFACTURER: "Panini" });
    await m.scrollUntilVisible(m.below(`msb-a-${env.WORKER_INDEX}`, "Sets"), { timeout: 7_000 });
    await utilDrillToCustom(m, { SPORT: `msb-sport-${env.WORKER_INDEX}`, YEAR: "2026", MANUFACTURER: "Topps" });
    await m.scrollUntilVisible(m.id("Add custom Sets"), { timeout: 7_000 });
    await m.assertNotVisible(`msb-a-${env.WORKER_INDEX}`);
    await utilDrillToCustom(m, { SPORT: `msb-sport-${env.WORKER_INDEX}`, YEAR: "2026", MANUFACTURER: "Panini", SET_NAME: `msb-a-${env.WORKER_INDEX}` });
    await m.assertVisible("Variant Types");
    await m.scrollUntilVisible("Move to another brand", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Move to another brand");
    await m.waitVisible("Move to which brand\\?", 7_000);
    await m.assertVisible(m.id("Move to Topps"));
    await m.assertNotVisible(m.id("Move to Panini"));
    await m.scrollUntilVisible(m.id("Move to Topps"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Move to Topps"));
    await m.waitVisible(`Move "msb-a-${env.WORKER_INDEX}" to Topps\\?`, 7_000);
    await m.tapOn("Yes, move it");
    await m.waitVisible("Moved to Topps", 7_000);
    await m.scrollUntilVisible(`.*2026 › Topps › msb-a-${env.WORKER_INDEX}.*`, { timeout: 7_000 });
  },
);
