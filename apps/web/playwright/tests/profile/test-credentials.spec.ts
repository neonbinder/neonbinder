// Port of .maestro/flows/profile/test-credentials.yaml
import { test } from "../../support/fixtures";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

test("Test BSC and SportLots Credentials", { tag: ["@credentials", "@profile"] }, async ({ m }) => {
  const SL_PAUSED = utilPausedPlatforms(m);
  await m.launch(m.signInUrl("/profile/credentials"));
  await m.waitVisible("Profile Settings", 45_000);

  await m.waitVisible("BuySportsCards Credentials", 30_000);
  await m.waitVisible(".*Connected to BuySportsCards.*", 7_000);
  await m.waitVisible("Test Credentials", 30_000);
  await m.scrollUntilVisible("Test Credentials", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Test Credentials");
  await m.waitVisible(".*BSC account authenticated successfully.*", 30_000);

  await m.tapOn("Sportlots");

  if (!SL_PAUSED) {
    await m.waitVisible(".*Sportlots Credentials.*", 10_000);
    await m.waitVisible(".*Connected to SportLots.*", 7_000);
    await m.waitVisible("Test Credentials", 30_000);
    await m.scrollUntilVisible("Test Credentials", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Test Credentials");
    await m.waitVisible(".*Sportlots account authenticated successfully.*", 30_000);
  }
  if (SL_PAUSED) {
    await m.waitVisible(".*Sportlots Credentials.*", 10_000);
    await m.waitVisible("SportLots is on pause", 7_000);
    await m.assertVisible("Sign-ins to SportLots are benched for now.*");
    await m.assertNotVisible("Test Credentials");
    await m.assertNotVisible("Sign in again");
  }
});
