// Port of .maestro/flows/labels/no-return-address-empty-state.yaml
import { test } from "../../support/fixtures";

test("Shipping Labels — no return address empty state", { tag: ["@labels"] }, async ({ m }) => {
  await m.launch(m.signInUrl("/testing/reset?redirect=/print/shipping", { account: "new-profile" }));

  await m.waitVisible(".*Add your return address on your profile first.*", 45_000);

  await m.assertVisible("Shipping Labels");
  await m.assertVisible("Go to Profile");

  await m.assertNotVisible("Ship To");
});
