// Port of .maestro/flows/profile/sportlots-paused-shows-notice.yaml
import { test } from "../../support/fixtures";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

test(
  "SportLots on pause — the Profile card and the Set Builder strip say so, and the strip dismisses (NEO-287)",
  { tag: ["@profile", "@credentials"] },
  async ({ m }) => {
    const SL_PAUSED = utilPausedPlatforms(m);
    await m.launch(m.signInUrl("/profile/credentials"));
    await m.waitVisible("Profile Settings", 45_000);

    await m.waitVisible("SportLots", 10_000);
    await m.tapOn("SportLots");
    await m.waitVisible(".*SportLots Credentials.*", 7_000);

    if (!SL_PAUSED) {
      await m.waitVisible("Test Credentials", 30_000);
      await m.assertNotVisible("SportLots is on pause");
      await m.assertNotVisible("Sign-in paused");
      await m.assertNotVisible("Test paused");

      await m.openLink("/admin/set-builder");
      await m.waitVisible(".*Build set parameters using marketplace APIs.*", 30_000);
      await m.assertNotVisible("SportLots is on pause\\.");
      await m.assertNotVisible(m.id("Dismiss pause notice"));
    }
    if (SL_PAUSED) {
      await m.waitVisible("SportLots is on pause", 7_000);
      await m.assertVisible("Sign-ins to SportLots are benched for now.*");
      await m.assertNotVisible("Test Credentials");
      await m.assertNotVisible("Sign in again");
      await m.assertNotVisible(".*SportLots Username.*");

      await m.openLink("/admin/set-builder");
      await m.waitVisible(".*Build set parameters using marketplace APIs.*", 30_000);
      await m.assertNotVisible("Set Builder requires marketplace credentials");
      await m.waitVisible("SportLots is on pause\\.", 7_000);
      await m.assertVisible(".*Syncs roll on with BuySportsCards only\\. Your SportLots links stay put — nothing gets unlinked\\..*");
      await m.assertVisible(m.id("Dismiss pause notice"));

      await m.tapOn(m.id("Dismiss pause notice"));
      await m.waitNotVisible("SportLots is on pause\\.", 7_000);
      await m.assertNotVisible(m.id("Dismiss pause notice"));
      await m.assertVisible(".*Build set parameters using marketplace APIs.*");
    }
  },
);
