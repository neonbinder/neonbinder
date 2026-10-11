// Port of .maestro/flows/set-selector/custom-set-exists-elsewhere-offers-drill.yaml
import { test } from "../../support/fixtures";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

test(
  "Custom entry — a name that already exists under another brand offers to go to it instead of making a second row (NEO-219)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilDrillToCustom(m, { SPORT: `xp-sport-${env.WORKER_INDEX}` });
    await m.scrollUntilVisible(m.id("Add custom Years"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Years"));
    await m.assertVisible("Add Custom Entry");
    await m.inputText("2o24");
    await m.pressKey("Enter");
    await m.waitVisible("Year must be a four-digit number", 7_000);
    await m.assertVisible("Add Custom Entry");
    await utilDrillToCustom(m, { SPORT: `xp-sport-${env.WORKER_INDEX}`, YEAR: "2026", MANUFACTURER: `xp-${env.WORKER_INDEX}-B`, SET_NAME: `xp-${env.WORKER_INDEX}-${env.ATTEMPT_ID} Chrome` });
    await m.scrollUntilVisible(`.*Attributes for xp-${env.WORKER_INDEX}-${env.ATTEMPT_ID} Chrome.*`, { centerElement: true, timeout: 7_000 });
    await m.assertVisible(`.*2026 › xp-${env.WORKER_INDEX}-B › xp-${env.WORKER_INDEX}-${env.ATTEMPT_ID} Chrome.*`);
    await utilDrillToCustom(m, { SPORT: `xp-sport-${env.WORKER_INDEX}`, YEAR: "2026", MANUFACTURER: `xp-${env.WORKER_INDEX}-A` });
    await m.scrollUntilVisible(m.id("Add custom Sets"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Sets"));
    await m.assertVisible("Add Custom Entry");
    await m.inputText(`xp-${env.WORKER_INDEX}-${env.ATTEMPT_ID} Chrome`);
    await m.pressKey("Enter");
    await m.waitVisible(`.*xp-${env.WORKER_INDEX}-${env.ATTEMPT_ID} Chrome. already exists under 2026 › xp-${env.WORKER_INDEX}-B.*`, 7_000);
    await m.assertVisible("Create here anyway");
    await m.tapOn("Go to it");
    await m.waitNotVisible("Add Custom Entry", 7_000);
    await m.scrollUntilVisible(`.*Attributes for xp-${env.WORKER_INDEX}-${env.ATTEMPT_ID} Chrome.*`, { centerElement: true, timeout: 7_000 });
    await m.assertVisible(`.*2026 › xp-${env.WORKER_INDEX}-B › xp-${env.WORKER_INDEX}-${env.ATTEMPT_ID} Chrome.*`);
  },
);
