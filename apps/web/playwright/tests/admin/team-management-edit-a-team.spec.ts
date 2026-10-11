// Port of .maestro/flows/admin/team-management-edit-a-team.yaml
import { test } from "../../support/fixtures";
import { pickNativeOption } from "../../support/subflows/native-select";
import { idWithText, valueOrText } from "../../support/value-selectors";

test(
  "Team Management — select a team and edit it",
  { tag: ["@admin"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/admin/players"));
    await m.waitVisible(".*of .* players.*", 45_000);

    const TOKEN = env.ATTEMPT_TOKEN;
    const LOC = `Loc${env.WORKER_INDEX}`;

    // ── A Baseball player to create a team through ──
    await m.tapOn("Filter players");
    await m.inputText("zzzznotaplayer");
    await m.assertVisible("No players match that filter.");
    await pickNativeOption(m, "Baseball"); // tapOn "All sports" + tapOn "Baseball"
    await m.waitVisible("0 matches", 7_000);
    await m.tapOn("Add player");
    await m.assertVisible("Add a player");
    await m.tapOn("New player name");
    await m.inputText(`TME${TOKEN}`);
    await m.scrollUntilVisible(m.id(`Create player TME${TOKEN}`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Create player TME${TOKEN}`));
    await m.waitVisible(m.above(`TME${TOKEN}`, "Player name"), 7_000);
    await m.assertVisible(`.*Added TME${TOKEN}.*`);

    await m.scrollUntilVisible(m.id("Add team"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`TMT${TOKEN}`);
    await m.assertVisible("No matches.");
    await m.pressKey("Enter");
    await m.assertVisible(`New team: TMT${TOKEN}`);
    await m.assertVisible(idWithText(m, "New team name", `TMT${TOKEN}`));
    await m.tapOn(m.id(`Create team TMT${TOKEN}`));
    await m.waitVisible(m.id(`Remove team TMT${TOKEN}`), 7_000);

    // ── Team Management: select the team, edit location + colour ──
    await m.openLink("/admin/teams");
    await m.waitVisible(".*of .* teams.*", 30_000);
    // No tap: the filter field holds focus on arrival.
    await m.inputText(`TMT${TOKEN}`);
    await m.waitVisible("1 of .* teams.*", 15_000);
    await m.tapOn(m.below(`TMT${TOKEN}`, "1 of .* teams.*"));

    await m.scrollUntilVisible("San Diego", { centerElement: true, timeout: 7_000 });
    await m.tapOn("San Diego");
    await m.inputText(LOC);
    await m.scrollUntilVisible("#01214b", { centerElement: true, timeout: 7_000 });
    await m.tapOn("#01214b");
    await m.inputText("#132448");
    await m.scrollUntilVisible("Save", { centerElement: true, timeout: 7_000 });
    await m.assertVisible("Discover");
    await m.tapOn("Save");
    await m.waitVisible(`.*Saved ${LOC} TMT${TOKEN}.*`, 15_000);

    // ── Reload: the edit persisted ──
    await m.openLink("/admin/teams");
    await m.waitVisible(".*of .* teams.*", 30_000);
    await m.inputText(`TMT${TOKEN}`);
    await m.waitVisible("1 of .* teams.*", 15_000);
    await m.tapOn(m.below(`TMT${TOKEN}`, "1 of .* teams.*"));
    await m.scrollUntilVisible("Location", { centerElement: true, timeout: 7_000 });
    await m.assertVisible(m.above(`${LOC} TMT${TOKEN}`, "Location"));
    await m.assertVisible(m.id(`${LOC} TMT${TOKEN}`));
    await m.assertVisible(valueOrText(m, `TMT${TOKEN}`, { below: "1 of .* teams.*", above: "Location" }));
    await m.assertVisible(valueOrText(m, LOC, { below: "Location" }));
    await m.scrollUntilVisible(valueOrText(m, "#132448"), { centerElement: true, timeout: 7_000 });

    // ── The new location-qualified name is what the player's team picker finds ──
    await m.openLink("/admin/players");
    await m.waitVisible(".*of .* players.*", 30_000);
    await m.tapOn("Filter players");
    await m.inputText(`TME${TOKEN}`);
    await m.waitVisible(m.id(`TME${TOKEN}`), 15_000);
    await m.tapOn(m.id(`TME${TOKEN}`));
    await m.scrollUntilVisible(m.id("Add team"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`${LOC} TMT${TOKEN}`);
    await m.assertVisible(m.id(`Add ${LOC} TMT${TOKEN}( · .*)?`));
    await m.pressKey("Enter");
    await m.waitVisible(m.id(`Remove team ${LOC} TMT${TOKEN}`), 7_000);
  },
);
