// Port of .maestro/flows/labels/get-postage-rate.yaml
// Needs DEV_EASYPOST_API_KEY (a TEST key) on the Convex deployment; never taps "Buy postage".
import { test } from "../../support/fixtures";
import type { Maestro } from "../../support/maestro";

/** scrollUntilVisible(centerElement) + tapOn + inputText, as the flow repeats it per field. */
async function fillField(m: Maestro, label: string, value: string): Promise<void> {
  await m.scrollUntilVisible(label, { centerElement: true, timeout: 7_000 });
  await m.tapOn(label);
  await m.inputText(value);
}

test("Shipping Labels — price a letter before buying it", { tag: ["@postage"] }, async ({ m }) => {
  await m.launch(
    m.signInUrl("/testing/reset?redirect=/testing/seed-credentials?redirect=/profile/shipping", {
      account: "new-profile",
    }),
  );
  await m.waitVisible("Profile Settings", 45_000);

  await m.waitVisible("Your return address for printed shipping labels", 10_000);
  await fillField(m, "Name", "Neon Seller");
  await fillField(m, "Street Address", "100 Binder Way");
  await fillField(m, "City", "Austin");
  await fillField(m, "State", "TX");
  await fillField(m, "ZIP", "78701");

  await m.scrollUntilVisible("Save Return Address", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Save Return Address");
  await m.assertVisible("Return address saved.");

  await m.openLink("/profile/postage");
  await m.waitVisible("EasyPost key saved.", 30_000);

  await m.openLink("/print/shipping");
  await m.assertVisible("Ship To");

  await fillField(m, "Name", "Dana Reyes");
  await fillField(m, "Street Address", "1600 Pennsylvania Ave NW");
  await fillField(m, "City", "Washington");
  await fillField(m, "State", "DC");
  await fillField(m, "ZIP", "20500");

  await m.scrollUntilVisible("1 oz", { centerElement: true, timeout: 7_000 });
  await m.assertVisible("Print Label");

  await m.waitVisible(".*\\$0\\.[0-9][0-9].*", 30_000);
  await m.assertVisible(".*Buy postage — \\$0\\.[0-9][0-9].*");
});
