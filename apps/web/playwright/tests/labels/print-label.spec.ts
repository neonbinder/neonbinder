// Port of .maestro/flows/labels/print-label.yaml
import { test } from "../../support/fixtures";
import type { Maestro } from "../../support/maestro";

/** scrollUntilVisible(centerElement) + tapOn + inputText, as the flow repeats it per field. */
async function fillField(m: Maestro, label: string, value: string): Promise<void> {
  await m.scrollUntilVisible(label, { centerElement: true, timeout: 7_000 });
  await m.tapOn(label);
  await m.inputText(value);
}

test(
  "Shipping Labels — type a recipient and the label preview follows",
  { tag: ["@smoke", "@labels"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/testing/reset?redirect=/profile/shipping", { account: "new-profile" }));
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

    await m.openLink("/print/shipping");
    await m.assertVisible("Shipping Labels");
    await m.assertVisible("Ship To");

    await fillField(m, "Name", "Jane Buyer");
    await fillField(m, "Street Address", "742 Evergreen Ter");
    await fillField(m, "City", "Springfield");
    await fillField(m, "State", "IL");
    await fillField(m, "ZIP", "62704");

    await m.scrollUntilVisible("Print Label", { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("SPRINGFIELD IL 62704", { centerElement: true, timeout: 7_000 });
    await m.assertVisible("AUSTIN TX 78701");
  },
);
