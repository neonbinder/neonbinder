// Port of .maestro/flows/set-selector/admin-missing-sl-shows-warning.yaml
import { test } from "../../support/fixtures";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

test(
  "Set Builder Gate — admin without SportLots credentials sees the warning banner",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    const SL_PAUSED = utilPausedPlatforms(m);
    const url = m.signInUrl("/set-selector", { account: "admin-bsc-only" });

    if (!SL_PAUSED) {
      await m.launch(url);
      await m.waitVisible("Set Builder requires marketplace credentials", 45_000);

      await m.openLink("/testing/seed-credentials?sites=buysportscards&redirect=/set-selector");
      await m.waitVisible("Set Builder requires marketplace credentials", 90_000);

      await m.assertVisible("Set Builder requires marketplace credentials");
      await m.assertVisible("SportLots");
      await m.assertNotVisible("BuySportsCards");
      await m.assertNotVisible(".*Build set parameters using marketplace APIs.*");

      await m.scrollUntilVisible(m.id("Configure credentials in Profile"), {
        centerElement: true,
        timeout: 7_000,
      });
      await m.tapOn(m.id("Configure credentials in Profile"));
      await m.assertVisible("Profile Settings");
    }
    if (SL_PAUSED) {
      await m.launch(url);
      await m.waitVisible(
        "Set Builder requires marketplace credentials|.*Build set parameters using marketplace APIs.*",
        45_000,
      );

      await m.openLink("/testing/seed-credentials?sites=buysportscards&redirect=/set-selector");
      await m.waitVisible(".*Build set parameters using marketplace APIs.*", 90_000);

      await m.assertNotVisible("Set Builder requires marketplace credentials");
      await m.waitVisible("SportLots is on pause\\.", 7_000);
      await m.assertVisible(
        ".*Syncs roll on with BuySportsCards only\\. Your SportLots links stay put — nothing gets unlinked\\..*",
      );
    }
  },
);
