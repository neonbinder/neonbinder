// Port of .maestro/flows/auth/sign-out.yaml
import { test } from "../../support/fixtures";

test("Sign Out", { tag: ["@auth"] }, async ({ m }) => {
  await m.launch(m.signInUrl("/dashboard"));
  await m.waitVisible("Sign out", 45_000);
  await m.tapOn("Sign out");
  await m.assertVisible("Get Started");
});
