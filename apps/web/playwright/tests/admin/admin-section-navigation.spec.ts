// Port of .maestro/flows/admin/admin-section-navigation.yaml
import { test } from "../../support/fixtures";

test(
  "Admin — the hub and its Set Builder / Teams sub-tabs",
  { tag: ["@smoke", "@admin"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/admin"));
    await m.waitVisible(".*Build set parameters from marketplace data.*", 45_000);

    await m.assertVisible(".*Resolve team colors, confirm ambiguous matches.*");

    await m.scrollUntilVisible(".*Resolve team colors, confirm ambiguous matches.*", {
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(".*Resolve team colors, confirm ambiguous matches.*");
    await m.assertVisible("Team Management");

    await m.scrollUntilVisible("Set Builder", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Set Builder");
    await m.assertVisible(".*Build set parameters using marketplace APIs.*");

    await m.assertNotVisible("Admin Tools");

    await m.scrollUntilVisible("Teams", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Teams");
    await m.assertVisible("Team Management");
  },
);
