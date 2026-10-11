// Port of .maestro/flows/profile/credentials-lifecycle.yaml
// NB: the flow targets the username/password inputs by DOM id (id: "username" / "password").
// Ported through their visible labels ("<Site> Username/Email", "<Site> Password") instead,
// which resolve to the same two inputs (label[for]).
import { test } from "../../support/fixtures";
import type { Maestro } from "../../support/maestro";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

/** scrollUntilVisible(Test Credentials) + tap, shared by every "test the stored credentials" step. */
async function tapTestCredentials(m: Maestro): Promise<void> {
  await m.waitVisible("Test Credentials", 30_000);
  await m.scrollUntilVisible("Test Credentials", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Test Credentials");
}

/** Clear Credentials -> confirm. The trailing `when: visible Yes, Clear` taps again if the dialog is still up. */
async function clearCredentials(m: Maestro): Promise<void> {
  await m.waitVisible("Clear Credentials", 30_000);
  await m.scrollUntilVisible("Clear Credentials", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Clear Credentials");
  await m.waitVisible("Yes, Clear", 7_000);
  await m.tapOn("Yes, Clear");
  if (await m.isVisible("Yes, Clear")) {
    await m.tapOn("Yes, Clear");
  }
}

/** Type a username and password into the (disconnected) credentials form, then Connect. */
async function typeFakeCredentials(m: Maestro, user: string, pass: string): Promise<void> {
  await m.scrollUntilVisible(m.id(".*Username.*"), { centerElement: true, timeout: 7_000 });
  await m.tapOn(m.id(".*Username.*"));
  await m.inputText(user);

  await m.scrollUntilVisible(m.id(".*Password.*"), { centerElement: true, timeout: 7_000 });
  await m.tapOn(m.id(".*Password.*"));
  await m.inputText(pass);

  await m.waitVisible("Connect", 30_000);
  await m.scrollUntilVisible("Connect", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Connect");
}

test(
  "Credentials lifecycle — connect, rejected sign-in, recover, clear (BSC + SportLots)",
  { tag: ["@credentials", "@profile"] },
  async ({ m }) => {
    const SL_PAUSED = utilPausedPlatforms(m);
    await m.launch(m.signInUrl("/profile/credentials", { account: "new-profile" }));
    await m.waitVisible("Profile Settings", 45_000);

    // ── BSC: seed, test, clear ──
    await m.openLink("/testing/seed-credentials?sites=buysportscards&redirect=/profile/credentials");
    await m.waitVisible("Profile Settings", 90_000);
    await m.waitVisible("BuySportsCards Credentials", 30_000);
    await m.waitVisible(".*Connected to BuySportsCards.*", 7_000);
    await tapTestCredentials(m);
    await m.waitVisible(".*BSC account authenticated successfully.*", 30_000);

    await clearCredentials(m);
    await m.waitVisible(".*Cleared your BuySportsCards connection.*", 30_000);
    await m.waitVisible(".*BuySportsCards Username.*", 30_000);

    // ── BSC: a rejected sign-in saves nothing ──
    await typeFakeCredentials(m, "e2e-fake-bsc-user", "e2e-fake-bsc-pass");
    await m.waitVisible(".*Could not sign in to BuySportsCards.*Nothing was saved.*", 120_000);
    await m.assertVisible(".*BuySportsCards Username.*");

    // ── BSC: recover by reseeding, test, reload, clear ──
    await m.openLink("/testing/seed-credentials?sites=buysportscards&redirect=/profile/credentials");
    await m.waitVisible("Profile Settings", 90_000);
    await m.waitVisible("BuySportsCards Credentials", 30_000);
    await m.waitVisible(".*Connected to BuySportsCards.*", 7_000);
    await tapTestCredentials(m);
    await m.waitVisible(".*BSC account authenticated successfully.*", 30_000);

    await m.openLink("/profile/credentials");
    await m.waitVisible("Profile Settings", 30_000);
    await m.waitVisible("BuySportsCards Credentials", 30_000);
    await clearCredentials(m);
    await m.waitVisible(".*Cleared your BuySportsCards connection.*", 30_000);
    await m.waitVisible(".*BuySportsCards Username.*", 7_000);

    if (!SL_PAUSED) {
      await m.openLink("/testing/seed-credentials?sites=sportlots&redirect=/profile/credentials");
      await m.waitVisible("Profile Settings", 90_000);
      await m.waitVisible("SportLots", 10_000);
      await m.tapOn("SportLots");
      await m.waitVisible(".*SportLots Credentials.*", 7_000);
      await m.waitVisible(".*Connected to SportLots.*", 7_000);
      await tapTestCredentials(m);
      await m.waitVisible(".*SportLots account authenticated successfully.*", 30_000);

      await clearCredentials(m);
      await m.waitVisible(".*Cleared your SportLots connection.*", 30_000);

      await m.openLink("/profile/credentials");
      await m.waitVisible("Profile Settings", 30_000);
      await m.waitVisible("SportLots", 10_000);
      await m.tapOn("SportLots");
      await m.waitVisible(".*SportLots Credentials.*", 7_000);
      await m.waitVisible(".*SportLots Username.*", 30_000);

      await typeFakeCredentials(m, "e2e-fake-sl-user", "e2e-fake-sl-pass");
      await m.waitVisible(".*SportLots wouldn't let us in the door.*", 120_000);
      await m.assertVisible(".*SportLots Username.*");

      await m.openLink("/testing/seed-credentials?sites=sportlots&redirect=/profile/credentials");
      await m.waitVisible("Profile Settings", 90_000);
      await m.waitVisible("SportLots", 10_000);
      await m.tapOn("SportLots");
      await m.waitVisible(".*SportLots Credentials.*", 7_000);
      await m.waitVisible(".*Connected to SportLots.*", 7_000);
      await tapTestCredentials(m);
      await m.waitVisible(".*SportLots account authenticated successfully.*", 30_000);

      await m.openLink("/profile/credentials");
      await m.waitVisible("Profile Settings", 30_000);
      await m.waitVisible("SportLots", 10_000);
      await m.tapOn("SportLots");
      await m.waitVisible(".*SportLots Credentials.*", 7_000);
      await clearCredentials(m);
      await m.waitVisible(".*Cleared your SportLots connection.*", 30_000);
      await m.waitVisible(".*SportLots Username.*", 7_000);
    }
    if (SL_PAUSED) {
      await m.openLink("/testing/seed-credentials?sites=sportlots&redirect=/profile/credentials");
      await m.waitVisible("Profile Settings", 30_000);
      await m.waitVisible("SportLots", 10_000);
      await m.tapOn("SportLots");
      await m.waitVisible(".*SportLots Credentials.*", 7_000);
      await m.waitVisible("SportLots is on pause", 7_000);
      await m.assertVisible("Sign-ins to SportLots are benched for now.*");
      await m.assertNotVisible(".*SportLots Username.*");
      await m.assertNotVisible("Connect");
      await m.assertNotVisible("Test Credentials");
      await m.assertNotVisible("Sign in again");
    }
  },
);
