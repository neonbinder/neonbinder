// Port of .maestro/flows/home/landing-marketing.yaml
import { test } from "../../support/fixtures";

test("Landing Page Marketing Content", { tag: ["@marketing", "@home"] }, async ({ m }) => {
  await m.launch("/");
  await m.assertVisible("Neon Binder");

  await m.scrollUntilVisible(".*Free Tier.*", { timeout: 7_000 });

  await m.scrollUntilVisible(".*Collection Tracking.*", { timeout: 7_000 });
  await m.assertVisible(".*AI-Based Card Identification.*");
  await m.assertVisible(".*Inventory.*");
  await m.scrollUntilVisible(".*Shipping Labels.*", { timeout: 7_000 });
  await m.scrollUntilVisible(".*Spine Labels in Team Colors.*", { timeout: 7_000 });
  await m.assertVisible(".*9-Pocket Placeholder Sheets.*");

  await m.scrollUntilVisible("How It Works", { timeout: 7_000 });
});
