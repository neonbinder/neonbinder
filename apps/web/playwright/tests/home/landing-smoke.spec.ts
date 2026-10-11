// Port of .maestro/flows/home/landing-smoke.yaml
import { test } from "../../support/fixtures";

test("Landing Page Smoke Test", { tag: ["@smoke", "@home"] }, async ({ m }) => {
  await m.launch("/");

  await m.assertVisible("Neon Binder");
  await m.assertVisible("Sign In");
  await m.assertVisible("Get Started");

  // R5 exception signed off by Jason 2026-09-09 (NEO-260): 25000 is page-length travel.
  await m.scrollUntilVisible("Create Free Account", { timeout: 25_000 });
});
