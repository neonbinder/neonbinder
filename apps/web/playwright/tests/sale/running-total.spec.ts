// Port of .maestro/flows/sale/running-total.yaml
import { test } from "../../support/fixtures";
import { utilFillPublicProfile } from "../../support/subflows/profile/util-fill-public-profile";

test("Sale page — running total accumulates", { tag: ["@smoke", "@sale"] }, async ({ m, env, page, context }) => {
  await m.launch(m.signInUrl("/testing/reset?redirect=/profile/public", { account: "new-profile" }));
  await m.waitVisible("Profile Settings", 45_000);

  await utilFillPublicProfile(m);

  // `launchApp: { clearState: true }` — drop the Clerk session and localStorage (the sale page is public).
  await page.evaluate(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await context.clearCookies();
  await m.launch("/");

  await m.openLink(`/u/${env.TEST_USERNAME}/sale?amt=5`);
  await m.assertVisible("Total Sale Amount");
  await m.assertVisible("\\$5.00");

  await m.openLink(`/u/${env.TEST_USERNAME}/sale?amt=3`);
  await m.assertVisible("\\$8.00");

  await m.scrollUntilVisible("PayPal [(]F&F[)]", { centerElement: true, timeout: 7_000 });
  await m.scrollUntilVisible("PayPal [(]G&S[)]", { centerElement: true, timeout: 7_000 });
  await m.scrollUntilVisible("Venmo", { centerElement: true, timeout: 7_000 });
  await m.scrollUntilVisible("Cash App", { centerElement: true, timeout: 7_000 });
});
