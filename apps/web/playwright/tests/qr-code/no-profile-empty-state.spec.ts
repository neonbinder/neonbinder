// Port of .maestro/flows/qr-code/no-profile-empty-state.yaml
import { test } from "../../support/fixtures";

test("QR Code — no profile empty state", { tag: ["@smoke", "@qr-code"] }, async ({ m }) => {
  await m.launch(m.signInUrl("/testing/reset?redirect=/print/qr", { account: "new-profile" }));

  await m.waitVisible("Set up your public profile first to generate sale QR codes.", 45_000);
  await m.assertVisible("Go to Profile");
});
