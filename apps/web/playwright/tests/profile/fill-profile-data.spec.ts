// Port of .maestro/flows/profile/fill-profile-data.yaml
import { test } from "../../support/fixtures";

test("Fill Profile Data", { tag: ["@profile"] }, async ({ m, env }) => {
  const U = env.TEST_USERNAME;
  await m.launch(m.signInUrl("/testing/reset?redirect=/profile/public", { account: "new-profile" }));
  await m.waitVisible("Profile Settings", 45_000);

  await m.scrollUntilVisible("Basic Info", { timeout: 7_000 });
  await m.tapOn("Username.*");
  await m.inputText(U);
  await m.tapOn("Display Name");
  await m.inputText(U);
  await m.tapOn("Tagline");
  await m.inputText("Buying and Selling all kinds of Sports Cards");

  await m.scrollUntilVisible("Marketplace Links", { timeout: 7_000 });
  await m.scrollUntilVisible("eBay Store URL", { centerElement: true, timeout: 7_000 });
  await m.tapOn("eBay Store URL");
  await m.inputText(`https://www.ebay.com/str/${U}`);
  await m.scrollUntilVisible("BuySportsCards URL", { centerElement: true, timeout: 7_000 });
  await m.tapOn("BuySportsCards URL");
  await m.inputText(`https://www.buysportscards.com/Seller/1d8570d204/${U}`);
  await m.scrollUntilVisible("Sportlots URL", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Sportlots URL");
  await m.inputText(`https://sportlots.com/dealers/?dealer=${U}`);
  await m.scrollUntilVisible("MySlabs URL", { centerElement: true, timeout: 7_000 });
  await m.tapOn("MySlabs URL");
  await m.inputText("http://myslabs.to/e8c447c0-5917-4326-be26-be2201e36d4a");

  await m.scrollUntilVisible("Payment Handles", { timeout: 7_000 });
  await m.scrollUntilVisible(".*PayPal username.*", { centerElement: true, timeout: 7_000 });
  await m.tapOn(".*PayPal username.*");
  await m.inputText(`${U}-pp`);
  await m.assertVisible(`→ paypal.me/${U}-pp`);
  await m.scrollUntilVisible(".*Venmo username.*", { centerElement: true, timeout: 7_000 });
  await m.tapOn(".*Venmo username.*");
  await m.inputText(`${U}-venmo`);
  await m.assertVisible(`→ venmo.com/${U}-venmo`);
  await m.scrollUntilVisible(".*Cash App username.*", { centerElement: true, timeout: 7_000 });
  await m.tapOn(".*Cash App username.*");
  await m.inputText(`${U}-cashapp`);
  // The "$" is literal in the preview text; escaped so the regex does not read it as an anchor.
  await m.assertVisible(`→ cash.app/\\$${U}-cashapp`);

  await m.scrollUntilVisible("Social Media", { timeout: 7_000 });
  await m.scrollUntilVisible("Twitter / X URL", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Twitter / X URL");
  await m.inputText(`https://x.com/${U}-twit`);
  await m.scrollUntilVisible("Instagram URL", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Instagram URL");
  await m.inputText(`https://instagram.com/${U}-ig`);
  await m.scrollUntilVisible("TikTok URL", { centerElement: true, timeout: 7_000 });
  await m.tapOn("TikTok URL");
  await m.inputText(`https://tiktok.com/@${U}-tt`);

  await m.scrollUntilVisible("Save Public Profile", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Save Public Profile");
  await m.waitVisible("Profile saved.*", 10_000);
  await m.assertVisible(`View your profile at /u/${U}`);

  await m.openLink(`/u/${U}`);
  await m.assertVisible("Buying and Selling all kinds of Sports Cards");
  await m.assertVisible(U);

  await m.assertVisible(`.*ebay.com/str/${U}.*`);
  await m.assertVisible(`.*buysportscards.com/Seller/1d8570d204/${U}.*`);
  await m.assertVisible(`.*sportlots.com/dealers.*${U}.*`);
  await m.assertVisible(".*myslabs.to/.*");

  await m.scrollUntilVisible(`.*paypal.me/${U}-pp.*`, { timeout: 7_000 });
  await m.scrollUntilVisible(`.*venmo.com/${U}-venmo.*`, { timeout: 7_000 });
  await m.scrollUntilVisible(`.*cash.app.*${U}-cashapp.*`, { timeout: 7_000 });

  await m.scrollUntilVisible(`.*x.com/${U}-twit.*`, { timeout: 7_000 });
  await m.assertVisible(`.*instagram.com/${U}-ig.*`);
  await m.assertVisible(`.*tiktok.com.*${U}-tt.*`);
});
