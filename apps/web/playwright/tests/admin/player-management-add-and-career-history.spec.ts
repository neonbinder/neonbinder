// Port of .maestro/flows/admin/player-management-add-and-career-history.yaml
import { test } from "../../support/fixtures";
import { pickNativeOption } from "../../support/subflows/native-select";
import { idWithText, valueOrText } from "../../support/value-selectors";

test(
  "Player Management — add a player by hand and record two stints at one team",
  { tag: ["@admin"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/admin/players"));
    await m.waitVisible(".*of .* players.*", 45_000);

    const TOKEN = env.ATTEMPT_TOKEN;

    await m.tapOn("Filter players");
    await m.inputText("zzzznotaplayer");
    await m.assertVisible("No players match that filter.");
    await m.assertVisible("0 matches");
    await pickNativeOption(m, "Baseball"); // tapOn "All sports" + tapOn "Baseball"
    await m.assertVisible("Baseball");
    await m.waitVisible("0 matches", 7_000);
    await m.scrollUntilVisible("Add player", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Add player");
    await m.waitVisible("Add a player", 7_000);

    await m.tapOn("New player name");
    await m.inputText(`PM${TOKEN}`);
    await m.scrollUntilVisible(m.id(`Create player PM${TOKEN}`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Create player PM${TOKEN}`));
    await m.waitVisible(m.above(`PM${TOKEN}`, "Player name"), 7_000);
    await m.assertVisible(`.*Added PM${TOKEN}.*`);
    await m.assertVisible(".*Sport: Baseball.*");

    // ── Create a team through the player's team picker ──
    await m.scrollUntilVisible("No stints recorded yet.", { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible(m.id("Add team"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`PMT${TOKEN}`);
    await m.assertVisible("No matches.");
    await m.pressKey("Enter");
    await m.assertVisible(`New team: PMT${TOKEN}`);
    await m.assertVisible(idWithText(m, "New team name", `PMT${TOKEN}`));
    await m.tapOn(m.id(`Create team PMT${TOKEN}`));
    await m.waitVisible(m.id(`Remove team PMT${TOKEN}`), 7_000);

    // ── First stint: 2010-2012 ──
    await m.tapOn("Career history");
    await m.tapOn(".*Stint from year.*");
    await m.inputText("2010");
    await m.tapOn(".*Stint to year.*");
    await m.inputText("2012");
    await m.tapOn("Add stint");
    await m.scrollUntilVisible(`.*PMT${TOKEN} · 2010–2012.*`, { centerElement: true, timeout: 7_000 });

    // ── Second stint at the same team: 2001-2005, ordered before the first ──
    await m.scrollUntilVisible(m.id("Add team"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`PMT${TOKEN}`);
    await m.tapOn(m.id(`Add PMT${TOKEN}( · .*)?`));
    await m.tapOn("Career history");
    await m.tapOn(".*Stint to year.*");
    await m.inputText("2005");
    await m.pressKey("Enter");
    await m.assertVisible(valueOrText(m, "2005"));
    await m.assertVisible(m.id(`Remove team PMT${TOKEN}( · .*)?`));
    await m.assertNotVisible("Pick a team and a whole start year\\.");
    await m.tapOn(".*Stint from year.*");
    await m.inputText("2001");
    await m.pressKey("Enter");
    await m.waitVisible(valueOrText(m, "present"), 7_000);
    await m.assertNotVisible(valueOrText(m, "2001"));
    await m.assertNotVisible(m.id(`Remove team PMT${TOKEN}( · .*)?`));
    await m.assertNotVisible("Pick a team and a whole start year\\.");
    await m.assertNotVisible(".*already has a stint starting in.*");
    await m.scrollUntilVisible(`.*PMT${TOKEN} · 2001–2005.*`, { centerElement: true, timeout: 7_000 });
    await m.assertVisible(m.below(`.*PMT${TOKEN} · 2010–2012.*`, `.*PMT${TOKEN} · 2001–2005.*`));

    await m.scrollUntilVisible("Save", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Save");
    await m.waitVisible(`.*Saved PM${TOKEN}.*`, 15_000);

    // ── Reload: the stints persisted, in order ──
    await m.openLink("/admin/players");
    await m.waitVisible(".*of .* players.*", 30_000);
    await m.tapOn("Filter players");
    await m.inputText(`PM${TOKEN}`);
    await m.waitVisible(".*matches.*", 7_000);
    await m.assertVisible(m.below(`.*PMT${TOKEN}.*`, ".*matches.*"));
    await m.tapOn(m.below(`PM${TOKEN}`, ".*matches.*"));
    await m.scrollUntilVisible(`.*PMT${TOKEN} · 2001–2005.*`, { centerElement: true, timeout: 7_000 });
    await m.assertVisible(m.below(`.*PMT${TOKEN} · 2010–2012.*`, `.*PMT${TOKEN} · 2001–2005.*`));
  },
);
