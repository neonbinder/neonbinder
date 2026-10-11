// Port of .maestro/flows/profile/session-expired-prompts-sign-in-again.yaml
import { test } from "../../support/fixtures";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

test(
  "Expired marketplace session — the panel says sign in again, and goes back to connected once the session proves good",
  { tag: ["@credentials", "@profile"] },
  async ({ m }) => {
    const SL_PAUSED = utilPausedPlatforms(m);
    await m.launch(m.signInUrl("/profile/credentials"));
    await m.waitVisible("Profile Settings", 45_000);

    if (!SL_PAUSED) {
      await m.openLink("/testing/seed-credentials?sites=sportlots&redirect=/profile/credentials");
      await m.waitVisible("Profile Settings", 90_000);

      await m.waitVisible("SportLots", 10_000);
      await m.tapOn("SportLots");
      await m.waitVisible(".*SportLots Credentials.*", 7_000);
      await m.waitVisible(".*Connected to SportLots.*", 7_000);
      await m.assertVisible("Test Credentials");

      await m.openLink("/testing/needs-reauth?site=sportlots&redirect=/profile/credentials");
      await m.waitVisible("Profile Settings", 30_000);
      await m.waitVisible("SportLots", 10_000);
      await m.tapOn("SportLots");
      await m.waitVisible(".*SportLots Credentials.*", 7_000);

      await m.waitVisible(".*Sign in to SportLots again.*", 7_000);
      await m.assertNotVisible("Test Credentials");
      await m.assertNotVisible(".*SportLots Username.*");

      await m.scrollUntilVisible("Sign in again", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Sign in again");

      await m.waitVisible(".*SportLots Username.*", 7_000);

      await m.scrollUntilVisible("Test Stored Credentials", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Test Stored Credentials");
      await m.waitVisible(".*SportLots account authenticated successfully.*", 30_000);

      await m.scrollUntilVisible("Cancel", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Cancel");

      await m.waitVisible(".*Connected to SportLots.*", 7_000);
    }
    if (SL_PAUSED) {
      await m.openLink("/testing/seed-credentials?sites=sportlots&redirect=/profile/credentials");
      await m.waitVisible("Profile Settings", 30_000);
      await m.waitVisible("SportLots", 10_000);
      await m.tapOn("SportLots");
      await m.waitVisible(".*SportLots Credentials.*", 7_000);
      await m.waitVisible("SportLots is on pause", 7_000);
      await m.assertNotVisible("Test Credentials");

      await m.openLink("/testing/needs-reauth?site=sportlots&redirect=/profile/credentials");
      await m.waitVisible("Profile Settings", 30_000);
      await m.waitVisible("SportLots", 10_000);
      await m.tapOn("SportLots");
      await m.waitVisible(".*SportLots Credentials.*", 7_000);

      await m.waitVisible("SportLots is on pause", 7_000);
      await m.assertVisible("Sign-ins to SportLots are benched for now.*");
      await m.assertNotVisible(".*Sign in to SportLots again.*");
      await m.assertNotVisible("Sign in again");
      await m.assertNotVisible("Test Credentials");
      await m.assertNotVisible(".*SportLots Username.*");
    }
  },
);
