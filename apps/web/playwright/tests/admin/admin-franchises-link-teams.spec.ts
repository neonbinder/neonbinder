// Port of .maestro/flows/admin/admin-franchises-link-teams.yaml
import { test } from "../../support/fixtures";
import { pickNativeOption } from "../../support/subflows/native-select";
import { idWithText } from "../../support/value-selectors";

test(
  "Franchises — two team rows are strung onto one franchise from the team side, and taken off again from the franchise side",
  { tag: ["@admin"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/admin/players"));
    await m.waitVisible(".*of .* players.*", 45_000);

    const TOKEN = env.ATTEMPT_TOKEN;

    // ── A Baseball player to hang two new teams on ──
    await m.tapOn("Filter players");
    await m.inputText("zzzznotaplayer");
    await m.assertVisible("No players match that filter.");
    await m.assertVisible("0 matches");
    await pickNativeOption(m, "Baseball"); // tapOn "All sports" + tapOn "Baseball"
    await m.assertVisible("Baseball");
    await m.waitVisible("0 matches", 7_000);
    await m.tapOn("Add player");
    await m.tapOn("New player name");
    await m.inputText(`Frp${TOKEN}`);
    await m.scrollUntilVisible(m.id(`Create player Frp${TOKEN}`), { timeout: 7_000 });
    await m.tapOn(m.id(`Create player Frp${TOKEN}`));
    await m.waitVisible(m.above(`Frp${TOKEN}`, "Player name"), 7_000);
    await m.assertVisible(`.*Added Frp${TOKEN}.*`);

    // ── Team A: created through the player's Add team picker, then removed ──
    await m.scrollUntilVisible("No stints recorded yet.", { centerElement: true, timeout: 7_000 });
    await m.assertVisible(m.id("Add team"));
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`Fr${TOKEN}A`);
    await m.assertVisible("No matches.");
    await m.pressKey("Enter");
    await m.assertVisible(`New team: Fr${TOKEN}A`);
    await m.tapOn(m.id("New team location \\(optional\\)"));
    await m.inputText(`Loc${TOKEN}`);
    await m.tapOn(m.id(`Create team Loc${TOKEN} Fr${TOKEN}A`));
    await m.waitVisible(m.id(`Remove team Loc${TOKEN} Fr${TOKEN}A`), 7_000);
    await m.tapOn(m.id(`Remove team Loc${TOKEN} Fr${TOKEN}A`));

    // ── Team B ──
    await m.assertVisible(m.id("Add team"));
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`Fr${TOKEN}B`);
    await m.assertVisible("No matches.");
    await m.pressKey("Enter");
    await m.assertVisible(`New team: Fr${TOKEN}B`);
    await m.tapOn(m.id("New team location \\(optional\\)"));
    await m.inputText(`Loc${TOKEN}`);
    await m.tapOn(m.id(`Create team Loc${TOKEN} Fr${TOKEN}B`));
    await m.waitVisible(m.id(`Remove team Loc${TOKEN} Fr${TOKEN}B`), 7_000);

    // ── Team Management: string both teams onto one franchise ──
    await m.openLink("/admin/teams");
    await m.waitVisible(".*of .* teams.*", 30_000);
    await m.tapOn("Filter teams");
    await m.inputText(`Fr${TOKEN}`);
    await m.waitVisible("2 of .* teams.*", 7_000);

    await m.tapOn(m.id(`Loc${TOKEN} Fr${TOKEN}A`));
    await m.scrollUntilVisible(m.id("Franchise"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Franchise"));
    await m.inputText(`Fran${TOKEN}F`);
    await m.waitVisible(idWithText(m, "Franchise", `Fran${TOKEN}F`), 7_000);
    await m.tapOn(`Start .Fran${TOKEN}F.`);
    await m.waitVisible(idWithText(m, "Franchise", `Fran${TOKEN}F`), 7_000);
    await m.scrollUntilVisible("Save", { centerElement: true, timeout: 7_000 });
    await m.waitVisible(
      `Started the Fran${TOKEN}F franchise\\. Save the team to put it on there\\.`,
      7_000,
    );
    await m.tapOn("Save");
    await m.waitVisible(`.*Saved Loc${TOKEN} Fr${TOKEN}A.*`, 7_000);

    await m.scrollUntilVisible(m.id(`Loc${TOKEN} Fr${TOKEN}B`), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id(`Loc${TOKEN} Fr${TOKEN}B`));
    await m.scrollUntilVisible(m.id("Franchise"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Franchise"));
    await m.inputText(`${TOKEN}F`);
    await m.waitVisible(idWithText(m, "Franchise", `${TOKEN}F`), 7_000);
    await m.tapOn(`Fran${TOKEN}F`);
    await m.waitVisible(idWithText(m, "Franchise", `Fran${TOKEN}F`), 7_000);
    await m.scrollUntilVisible("Save", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Save");
    await m.waitVisible(`.*Saved Loc${TOKEN} Fr${TOKEN}B.*`, 7_000);

    // ── Franchise side: both teams listed, take one off again ──
    await m.scrollUntilVisible("See the franchise", {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn("See the franchise");
    await m.waitVisible(".*of .* franchises.*", 7_000);
    await m.waitVisible(".*2 teams on this thread.*", 7_000);
    await m.scrollUntilVisible(`Loc${TOKEN} Fr${TOKEN}A`, { centerElement: true, timeout: 7_000 });
    await m.assertVisible(`Loc${TOKEN} Fr${TOKEN}B`);
    await m.scrollUntilVisible(`Remove Loc${TOKEN} Fr${TOKEN}B`, { centerElement: true, timeout: 7_000 });
    await m.tapOn(`Remove Loc${TOKEN} Fr${TOKEN}B`);
    await m.scrollUntilVisible("Franchise name", {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.waitVisible(".*1 team on this thread.*", 7_000);
    await m.scrollUntilVisible(`Remove Loc${TOKEN} Fr${TOKEN}A`, {
      direction: "DOWN",
      centerElement: true,
      timeout: 7_000,
    });
    await m.assertVisible(`Loc${TOKEN} Fr${TOKEN}A`);
    await m.assertNotVisible(`Loc${TOKEN} Fr${TOKEN}B`);
  },
);
