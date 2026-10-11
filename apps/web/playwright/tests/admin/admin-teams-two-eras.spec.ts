// Port of .maestro/flows/admin/admin-teams-two-eras.yaml
import { test } from "../../support/fixtures";
import { pickNativeOption } from "../../support/subflows/native-select";
import { valueOrText } from "../../support/value-selectors";

test(
  "Teams — one location and nickname can be two teams when their eras differ, and the second is only created once the operator confirms it",
  { tag: ["@admin"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/admin/players"));
    await m.waitVisible(".*of .* players.*", 45_000);

    const TOKEN = env.ATTEMPT_TOKEN;

    // ── A Baseball player to hang the teams on ──
    await m.tapOn("Filter players");
    await m.inputText("zzzznotaplayer");
    await m.assertVisible("No players match that filter.");
    await m.assertVisible("0 matches");
    await pickNativeOption(m, "Baseball"); // tapOn "All sports" + tapOn "Baseball"
    await m.assertVisible("Baseball");
    await m.waitVisible("0 matches", 7_000);
    await m.tapOn("Add player");
    await m.tapOn("New player name");
    await m.inputText(`Erp${TOKEN}`);
    await m.scrollUntilVisible(m.id(`Create player Erp${TOKEN}`), { timeout: 7_000 });
    await m.tapOn(m.id(`Create player Erp${TOKEN}`));
    await m.waitVisible(m.above(`Erp${TOKEN}`, "Player name"), 7_000);
    await m.assertVisible(`.*Added Erp${TOKEN}.*`);

    // ── First era: 1972-1996 ──
    await m.scrollUntilVisible("No stints recorded yet.", { centerElement: true, timeout: 7_000 });
    await m.assertVisible(m.id("Add team"));
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`Era${TOKEN}`);
    await m.assertVisible("No matches.");
    await m.pressKey("Enter");
    await m.assertVisible(`New team: Era${TOKEN}`);
    await m.tapOn(m.id("New team location \\(optional\\)"));
    await m.inputText(`Loc${TOKEN}`);
    await m.tapOn(m.id("New team active from \\(optional\\)"));
    await m.inputText("1972");
    await m.tapOn(m.id("New team active to"));
    await m.inputText("1996");
    await m.tapOn(m.id(`Create team Loc${TOKEN} Era${TOKEN}`));
    await m.waitVisible(m.id(`Remove team Loc${TOKEN} Era${TOKEN}`), 7_000);
    await m.tapOn(m.id(`Remove team Loc${TOKEN} Era${TOKEN}`));

    // ── Second era: same name, 2011-present, only after the operator confirms ──
    await m.assertVisible(m.id("Add team"));
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`Zzz${TOKEN}`);
    await m.assertVisible("No matches.");
    await m.pressKey("Enter");
    await m.assertVisible(`New team: Zzz${TOKEN}`);
    await m.tapOn(m.id("New team name"));
    await m.eraseText(40);
    await m.inputText(`Era${TOKEN}`);
    await m.tapOn(m.id("New team location \\(optional\\)"));
    await m.inputText(`Loc${TOKEN}`);
    await m.tapOn(m.id("New team active from \\(optional\\)"));
    await m.inputText("2011");
    await m.tapOn(m.id(`Create team Loc${TOKEN} Era${TOKEN}`));
    await m.waitVisible(
      ".*already exists for 1972–1996. Create again to add this as a second era.*",
      7_000,
    );
    await m.tapOn(m.id(`Create team Loc${TOKEN} Era${TOKEN}`));
    await m.waitVisible(m.id(`Remove team Loc${TOKEN} Era${TOKEN}`), 7_000);

    // ── Team Management: two rows, two eras ──
    await m.openLink("/admin/teams");
    await m.waitVisible(".*of .* teams.*", 30_000);
    await m.tapOn("Filter teams");
    await m.inputText(`Era${TOKEN}`);
    await m.waitVisible("2 of .* teams.*", 7_000);
    await m.assertVisible(m.below("1972–1996", ".*of .* teams.*"));
    await m.assertVisible(m.below("2011–present", ".*of .* teams.*"));

    await m.tapOn(m.below("1972–1996", ".*of .* teams.*"));
    await m.scrollUntilVisible("Active from", { centerElement: true, timeout: 7_000 });
    await m.assertVisible(valueOrText(m, "1972", { below: "Active from" }));
    await m.assertVisible(valueOrText(m, "1996", { below: "Active from" }));

    await m.scrollUntilVisible("2011–present", { direction: "UP", timeout: 7_000 });
    await m.tapOn(m.below("2011–present", ".*of .* teams.*"));
    await m.scrollUntilVisible("Active from", { centerElement: true, timeout: 7_000 });
    await m.assertVisible(valueOrText(m, "2011", { below: "Active from" }));
    await m.assertNotVisible(valueOrText(m, "1996"));
  },
);
