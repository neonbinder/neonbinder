// Port of .maestro/flows/admin/team-management-filter.yaml
import { test } from "../../support/fixtures";

test(
  "Team Management — filtering to a name nothing matches reports no matches",
  { tag: ["@smoke", "@admin"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/admin/teams"));
    await m.waitVisible("Team Management", 45_000);
    await m.assertVisible(".*of .* teams.*");
    await m.assertVisible("Select a team to see and edit everything we know about it.");
    await m.scrollUntilVisible("Filter teams", { centerElement: true, timeout: 7_000 });
    // The flow types with no tap: the filter field holds focus on arrival.
    await m.inputText("zzzznotateam");
    // Maestro `text:` matches an input value; Playwright needs m.value().
    await m.assertVisible(m.value("zzzznotateam"));
    await m.assertVisible("No teams match that filter.");
    await m.assertVisible("0 of .* teams.*");
    await m.assertVisible("Select a team to see and edit everything we know about it.");
  },
);
