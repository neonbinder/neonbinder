/** Port of .maestro/flows/util/util-login-to-bsc.yaml. */
import type { Maestro } from "../../maestro";

export async function utilLoginToBsc(m: Maestro): Promise<void> {
  await m.openLink("/profile/credentials");
  await m.waitVisible("Profile Settings", 10_000);
  await m.waitVisible(".*Connected to BuySportsCards.*", 7_000);
  await m.waitVisible("Test Credentials", 30_000);
  await m.scrollUntilVisible("Test Credentials", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Test Credentials");
  // Live BSC round-trip (R5 marketplace exception), 30 s as in the flow.
  await m.waitVisible(".*BSC account authenticated successfully.*", 30_000);
}
