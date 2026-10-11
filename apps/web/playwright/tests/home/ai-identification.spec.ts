// Port of .maestro/flows/home/ai-identification.yaml
import { test } from "../../support/fixtures";

test("AI Card Identification Feature Page", { tag: ["@marketing", "@home"] }, async ({ m }) => {
  await m.launch("/");
  await m.assertVisible("Neon Binder");

  // R5 exception signed off by Jason 2026-09-09 (NEO-260): 11000 is page-length travel.
  await m.scrollUntilVisible(".*AI-Based.*", { centerElement: true, timeout: 11_000 });
  await m.tapOn(".*AI-Based.*");

  await m.assertVisible("Instant Recognition");
  await m.scrollUntilVisible("Complete Card Data", { timeout: 7_000 });
  await m.scrollUntilVisible("Accuracy & Verification", { timeout: 7_000 });
  await m.scrollUntilVisible("Machine Learning", { timeout: 7_000 });

  await m.scrollUntilVisible("Get Started", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Get Started");
  await m.assertVisible("Create your account");

  await m.tapPoint("5%, 50%");
  await m.assertNotVisible("Create your account");

  await m.tapOn("Back");
  await m.assertVisible(".*Sign In.*");
});
