// Port of .maestro/flows/set-selector/reauth-notice-on-set-builder.yaml
import { test } from "../../support/fixtures";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

test(
  "Lapsed marketplace session — the Set Builder says so, its link lands on the credentials page, and Dismiss hides it (NEO-278)",
  { tag: ["@credentials", "@set-selector"] },
  async ({ m }) => {
    const SL_PAUSED = utilPausedPlatforms(m);

    await m.launch(m.signInUrl("/admin/set-builder"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    if (!SL_PAUSED) {
      await m.assertNotVisible(".*sessions? ran out.*");

      await m.openLink("/testing/needs-reauth?site=sportlots&redirect=/admin/set-builder");
      await m.waitVisible(".*Build set parameters using marketplace APIs.*", 30_000);

      await m.waitVisible("Your SportLots session ran out.", 7_000);
      await m.assertVisible(".*Syncs are running on borrowed time\\. Sign in again to keep them rolling\\..*");
      await m.assertVisible("Sign in again on your Profile →");
      await m.assertVisible(m.id("Dismiss sign-in notice"));

      await m.tapOn("Sign in again on your Profile →");
      await m.waitVisible("Profile Settings", 7_000);
      await m.waitVisible(".*BuySportsCards Credentials.*", 7_000);

      await m.openLink("/admin/set-builder");
      await m.waitVisible(".*Build set parameters using marketplace APIs.*", 30_000);
      await m.waitVisible("Your SportLots session ran out.", 7_000);

      await m.tapOn(m.id("Dismiss sign-in notice"));
      await m.waitNotVisible("Your SportLots session ran out.", 7_000);
      await m.assertVisible(".*Build set parameters using marketplace APIs.*");

      await m.openLink("/testing/seed-credentials?sites=sportlots&redirect=/profile/credentials");
      await m.waitVisible("Profile Settings", 90_000);

      await m.waitVisible("SportLots", 7_000);
      await m.tapOn("SportLots");
      await m.waitVisible(".*SportLots Credentials.*", 7_000);
      await m.waitVisible(".*Connected to SportLots.*", 7_000);
    } else {
      await m.waitVisible("SportLots is on pause\\.", 7_000);
      await m.assertNotVisible(".*sessions? ran out.*");

      await m.openLink("/testing/needs-reauth?site=sportlots&redirect=/admin/set-builder");
      await m.waitVisible(".*Build set parameters using marketplace APIs.*", 30_000);

      await m.waitVisible("SportLots is on pause\\.", 7_000);
      await m.assertVisible(
        ".*Syncs roll on with BuySportsCards only\\. Your SportLots links stay put — nothing gets unlinked\\..*",
      );
      await m.assertNotVisible("Your SportLots session ran out.");
      await m.assertNotVisible(".*sessions? ran out.*");
      await m.assertNotVisible(m.id("Dismiss sign-in notice"));
    }
  },
);
