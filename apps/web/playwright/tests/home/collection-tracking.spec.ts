// Port of .maestro/flows/home/collection-tracking.yaml
import { test } from "../../support/fixtures";

test("Collection Tracking Feature Page", { tag: ["@marketing", "@home"] }, async ({ m }) => {
  await m.launch("/");
  await m.assertVisible("Neon Binder");

  // R5 exception signed off by Jason 2026-09-09 (NEO-260): 11000 is page-length travel.
  await m.scrollUntilVisible(".*Collection Tracking.*", { centerElement: true, timeout: 11_000 });
  await m.tapOn(".*Collection Tracking.*");

  await m.assertVisible("Snap & Upload");
  await m.scrollUntilVisible("We Find Your Cards", { timeout: 7_000 });
  await m.scrollUntilVisible("Build It Your Way", { timeout: 7_000 });
  await m.scrollUntilVisible("Track Everything", { timeout: 7_000 });

  // R5 exception signed off by Jason 2026-09-09 (NEO-260): 12000 is travel.
  await m.scrollUntilVisible("Get Started", { centerElement: true, timeout: 12_000 });
  await m.tapOn("Get Started");
  await m.assertVisible("Create your account");

  await m.tapPoint("5%, 50%");
  await m.assertNotVisible("Create your account");
  await m.tapOn("Back");
  await m.assertVisible("Sign In");
});
