/** Port of .maestro/flows/util/util-login-to-sportlots.yaml. */
import type { Maestro } from "../../maestro";

export async function utilLoginToSportlots(m: Maestro): Promise<void> {
  if (!m.env.SL_PAUSED) {
    await m.openLink("/profile/credentials");
    await m.waitVisible("Profile Settings", 10_000);
    await m.waitVisible("Sportlots", 10_000);
    await m.tapOn("Sportlots");
    await m.waitVisible(".*Connected to SportLots.*", 7_000);
    await m.waitVisible("Test Credentials", 30_000);
    await m.scrollUntilVisible("Test Credentials", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Test Credentials");
    // Live SportLots round-trip (R5 marketplace exception).
    await m.waitVisible(".*Sportlots account authenticated successfully.*", 30_000);
  } else {
    await m.openLink("/profile/credentials");
    await m.waitVisible("Profile Settings", 10_000);
    await m.waitVisible("Sportlots", 10_000);
    await m.tapOn("Sportlots");
    await m.waitVisible(".*SportLots Credentials.*", 7_000);
    await m.waitVisible("SportLots is on pause", 7_000);
    await m.assertVisible("Sign-ins to SportLots are benched for now.*");
    await m.assertNotVisible("Test Credentials");
    await m.assertNotVisible(".*SportLots Username.*");
  }
}
