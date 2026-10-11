// Port of .maestro/flows/home/print-shop.yaml
import { test } from "../../support/fixtures";

test("Print Shop Feature Page", { tag: ["@marketing", "@home"] }, async ({ m }) => {
  await m.launch("/");
  await m.assertVisible("Neon Binder");

  // R5 exceptions signed off by Jason 2026-09-09 (NEO-260): 16000 and 12000 are page-length travel.
  await m.scrollUntilVisible(".*Spine Labels in Team Colors.*", { centerElement: true, timeout: 16_000 });
  await m.tapOn(".*Spine Labels in Team Colors.*");

  await m.assertVisible("The Print Shop");
  await m.scrollUntilVisible("Spine Labels In Team Colors", { timeout: 7_000 });
  await m.scrollUntilVisible("Hold Their Spot In The Binder", { timeout: 7_000 });
  await m.scrollUntilVisible("Print, Cut, Slide In", { timeout: 7_000 });

  await m.scrollUntilVisible("Get Started", { centerElement: true, timeout: 12_000 });
  await m.tapOn("Get Started");
  await m.assertVisible("Create your account");

  await m.tapPoint("5%, 50%");
  await m.assertNotVisible("Create your account");
  await m.tapOn("Back");
  await m.assertVisible("Sign In");
});
