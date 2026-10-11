/**
 * Port of .maestro/flows/profile/util-fill-public-profile.yaml — fills and
 * saves the signed-in user's public profile under TEST_USERNAME. Caller is
 * signed in and on a freshly-reset /profile/public.
 */
import type { Maestro } from "../../maestro";

export async function utilFillPublicProfile(m: Maestro, _o: Record<string, never> = {}): Promise<void> {
  const U = m.env.TEST_USERNAME;

  await m.assertVisible("Profile Settings");

  await m.scrollUntilVisible("Basic Info", { timeout: 7000 });
  await m.tapOn("Username.*");
  await m.inputText(U);
  await m.tapOn("Display Name");
  await m.inputText(U);
  await m.tapOn("Tagline");
  await m.inputText("Buying and Selling all kinds of Sports Cards");

  // R5 exception signed off by Jason 2026-09-09 (NEO-260): 10000.
  await m.scrollUntilVisible("Payment Handles", { timeout: 10000 });
  await m.scrollUntilVisible(".*PayPal username.*", { centerElement: true, timeout: 7000 });
  await m.tapOn(".*PayPal username.*");
  await m.inputText(`${U}-pp`);
  await m.assertVisible(`→ paypal.me/${U}-pp`);
  await m.scrollUntilVisible(".*PayPal email [(]Goods & Services[)].*", { centerElement: true, timeout: 7000 });
  await m.tapOn(".*PayPal email [(]Goods & Services[)].*");
  await m.inputText(`${U}@example.com`);
  await m.scrollUntilVisible(".*Venmo username.*", { centerElement: true, timeout: 7000 });
  await m.tapOn(".*Venmo username.*");
  await m.inputText(`${U}-venmo`);
  await m.assertVisible(`→ venmo.com/${U}-venmo`);
  await m.scrollUntilVisible(".*Cash App username.*", { centerElement: true, timeout: 7000 });
  await m.tapOn(".*Cash App username.*");
  await m.inputText(`${U}-cashapp`);
  // The "$" is literal in the preview text ("cash.app/$<handle>"); escaped for the regex.
  await m.assertVisible(`→ cash.app/\\$?${U}-cashapp`);

  await m.scrollUntilVisible("Save Public Profile", { centerElement: true, timeout: 7000 });
  await m.tapOn("Save Public Profile");
  await m.waitVisible("Profile saved.*", 10000);
  await m.assertVisible(`View your profile at /u/${U}`);
}
