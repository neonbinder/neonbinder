// Port of .maestro/flows/set-selector/admin-missing-both-shows-warning.yaml
import { test } from "../../support/fixtures";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

test(
  "Set Builder Gate — admin with neither BSC nor SportLots credentials sees the warning banner",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector", { account: "admin-no-credentials" }));
    await m.waitVisible("Set Builder requires marketplace credentials", 45_000);
    const SL_PAUSED = utilPausedPlatforms(m);
    if (!SL_PAUSED) {
      await m.assertVisible(".*BuySportsCards and SportLots.*");
    }
    if (SL_PAUSED) {
      await m.assertVisible(".*You need to connect.*");
      await m.assertVisible("BuySportsCards");
      await m.assertNotVisible(".*BuySportsCards and SportLots.*");
      await m.assertNotVisible("SportLots");
    }
    await m.assertNotVisible(".*Build set parameters using marketplace APIs.*");
    await m.assertNotVisible("Sync Sports");

    await m.scrollUntilVisible(m.id("Configure credentials in Profile"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Configure credentials in Profile"));
    await m.assertVisible("Profile Settings");
  },
);
