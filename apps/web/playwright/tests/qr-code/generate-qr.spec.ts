// Port of .maestro/flows/qr-code/generate-qr.yaml
import { test } from "../../support/fixtures";
import { utilFillPublicProfile } from "../../support/subflows/profile/util-fill-public-profile";

test("QR Code — generate sale QR", { tag: ["@smoke", "@qr-code"] }, async ({ m, env }) => {
  await m.launch(m.signInUrl("/testing/reset?redirect=/profile/public", { account: "new-profile" }));
  await m.waitVisible("Profile Settings", 45_000);

  await utilFillPublicProfile(m);

  await m.openLink("/print/qr");
  await m.assertVisible("QR Code Generator");

  await m.tapOn("Sale Amount");
  await m.inputText("8");

  await m.scrollUntilVisible("Generate QR Code", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Generate QR Code");

  await m.scrollUntilVisible("Download", { centerElement: true, timeout: 7_000 });

  await m.assertVisible(`.*neonbinder.io/u/${env.TEST_USERNAME}/sale[?]amt=8.*`);
  await m.assertVisible("Download");
  await m.assertVisible("Print");
});
