// Port of .maestro/flows/profile/view-profile.yaml
import { test } from "../../support/fixtures";

test("View Profile", { tag: ["@smoke", "@profile"] }, async ({ m }) => {
  await m.launch(m.signInUrl("/profile/public"));
  await m.waitVisible("Profile Settings", 45_000);
  await m.assertVisible("Public Profile");
});
