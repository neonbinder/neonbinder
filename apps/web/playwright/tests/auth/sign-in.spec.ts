// Port of .maestro/flows/auth/sign-in.yaml
import { test } from "../../support/fixtures";

test("Sign In", { tag: ["@smoke", "@auth"] }, async ({ m }) => {
  await m.launch(m.signInUrl("/dashboard"));
  // Gate on "Sign out" (proves sign-in), 45 s for the Clerk bootstrap.
  await m.waitVisible("Sign out", 45_000);
  await m.assertVisible("Neon Binder");
});
