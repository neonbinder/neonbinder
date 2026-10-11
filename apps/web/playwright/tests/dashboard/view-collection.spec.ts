// Port of .maestro/flows/dashboard/view-collection.yaml
import { test } from "../../support/fixtures";

test("View Collection (Dashboard)", { tag: ["@smoke", "@dashboard"] }, async ({ m }) => {
  await m.launch(m.signInUrl("/dashboard"));
  await m.waitVisible("COMING SOON", 45_000);
  await m.assertVisible("Neon Binder");
});
