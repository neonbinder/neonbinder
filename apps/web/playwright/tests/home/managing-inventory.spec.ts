// Port of .maestro/flows/home/managing-inventory.yaml
import { test } from "../../support/fixtures";

test("Managing Inventory Feature Page", { tag: ["@marketing", "@home"] }, async ({ m }) => {
  await m.launch("/");
  await m.assertVisible("Neon Binder");

  // R5 exception signed off by Jason 2026-09-09 (NEO-260): 11000 is page-length travel.
  await m.scrollUntilVisible(".*Multiple Inventory.*", { centerElement: true, timeout: 11_000 });
  await m.tapOn(".*Multiple Inventory.*");

  await m.assertVisible("One Upload, Multiple Platforms");
  await m.scrollUntilVisible("Real-Time Inventory Control", { timeout: 7_000 });
  await m.scrollUntilVisible("Sales Intelligence", { timeout: 7_000 });
  await m.scrollUntilVisible("Dominate the Card Show", { timeout: 7_000 });

  await m.scrollUntilVisible("Get Started", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Get Started");
  await m.assertVisible("Create your account");

  await m.tapPoint("5%, 50%");
  await m.assertNotVisible("Create your account");
  await m.tapOn("Back");
  await m.assertVisible("Sign In");
});
