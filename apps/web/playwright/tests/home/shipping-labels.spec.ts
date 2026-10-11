// Port of .maestro/flows/home/shipping-labels.yaml
import { test } from "../../support/fixtures";

test("Shipping Labels Feature Page", { tag: ["@marketing", "@home"] }, async ({ m }) => {
  await m.launch("/");
  await m.assertVisible("Neon Binder");

  // R5 exceptions signed off by Jason 2026-09-09 (NEO-260): 16000 and 12000 are page-length travel.
  await m.scrollUntilVisible(".*Shipping Labels.*", { centerElement: true, timeout: 16_000 });
  await m.tapOn(".*Shipping Labels.*");

  await m.assertVisible("Print the Label, Ship the Card");
  await m.scrollUntilVisible("Your Address, Saved Once", { timeout: 7_000 });
  await m.scrollUntilVisible("Type The Buyer, Hit Print", { timeout: 7_000 });
  // The "." stands in for the multiplication sign in "Fits Any 4×6 Label Printer".
  await m.scrollUntilVisible("Fits Any 4.6 Label Printer", { timeout: 7_000 });
  await m.scrollUntilVisible("Buy The Postage Too", { timeout: 7_000 });

  await m.scrollUntilVisible("Get Started", { centerElement: true, timeout: 12_000 });
  await m.tapOn("Get Started");
  await m.assertVisible("Create your account");

  await m.tapPoint("5%, 50%");
  await m.assertNotVisible("Create your account");
  await m.tapOn("Back");
  await m.assertVisible("Sign In");
});
