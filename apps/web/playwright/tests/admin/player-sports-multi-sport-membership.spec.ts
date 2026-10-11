// Port of .maestro/flows/admin/player-sports-multi-sport-membership.yaml
import { test } from "../../support/fixtures";
import { pickNativeOption } from "../../support/subflows/native-select";
import { utilAddPlayerByHand } from "../../support/subflows/admin/util-add-player-by-hand";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

test(
  "Player sports — give a football player Baseball too; he is listed as a baseball player, a baseball card's picker finds him without a switch, and Baseball cannot be removed while that card links him (NEO-313)",
  { tag: ["@admin"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/admin/players"));
    await m.waitVisible(".*of .* players.*", 45_000);

    const TOKEN = env.ATTEMPT_TOKEN;
    const drillToSet = () =>
      utilDrillToCustom(m, {
        SPORT: "Baseball",
        YEAR: "2024",
        MANUFACTURER: "Topps",
        SET_NAME: `msp-${env.WORKER_INDEX}`,
        VARIANT_TYPE: "Insert",
        VARIANT: "Base",
      });

    // ── A Football player, then give him Baseball too ──
    await utilAddPlayerByHand(m, { PLAYER_NAME: `Gm${TOKEN}`, SPORT: "Football" });

    await m.scrollUntilVisible("Add sport", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Add sport");
    await m.waitVisible(m.id("Add sport Baseball"), 7_000);
    await m.tapOn(m.id("Add sport Baseball"));
    await m.waitVisible("Added Baseball\\.", 7_000);
    await m.assertVisible(m.id("Remove sport Baseball"));

    // ── Listed as a Baseball player ──
    await m.openLink("/admin/players");
    await m.waitVisible(".*of .* players.*", 20_000);
    await m.tapOn("Filter players");
    await m.inputText(`Gm${TOKEN}`);
    await m.waitVisible(".*matches.*", 7_000);
    await pickNativeOption(m, "Baseball"); // tapOn "All sports" + tapOn "Baseball"
    await m.waitVisible(m.below("Also: Baseball", ".*matches.*"), 7_000);
    await m.assertVisible(m.below(`Gm${TOKEN}`, ".*matches.*"));

    // ── A Baseball card's player picker finds him without a sport switch ──
    await drillToSet();
    await m.scrollUntilVisible(m.id("Open add card form"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.inputText(`316-${env.ATTEMPT_ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Two Sport Card ${env.ATTEMPT_ID}`);
    await m.scrollUntilVisible(m.id("Add a player to the new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add a player to the new card"));
    await m.tapOn(m.id("Find a player for the new card"));
    await m.inputText(`Gm${TOKEN}`);
    await m.assertVisible(m.id("Sport to search for players: Baseball"));
    await m.waitVisible(m.id(`Add Gm${TOKEN}`), 7_000);
    await m.assertNotVisible(m.id(`Create player Gm${TOKEN}`));
    await m.tapOn(m.id(`Add Gm${TOKEN}`));
    await m.waitVisible(m.id(`Remove player Gm${TOKEN}`), 7_000);
    await m.tapOn(m.id("Card name"));
    await m.waitNotVisible(m.id("Find a player for the new card"), 7_000);
    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.waitNotVisible(m.id("Card name"), 7_000);

    // ── Baseball cannot be removed while that card links him ──
    await m.openLink("/admin/players");
    await m.waitVisible(".*of .* players.*", 20_000);
    await m.tapOn("Filter players");
    await m.inputText(`Gm${TOKEN}`);
    await m.waitVisible(".*matches.*", 7_000);
    await m.tapOn(m.below(`Gm${TOKEN}`, ".*matches.*"));
    await m.scrollUntilVisible(m.id("Remove sport Baseball"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Remove sport Baseball"));
    await m.waitVisible(`.*1 card in Baseball sets still link to Gm${TOKEN}\\..*`, 7_000);
    await m.assertVisible(m.id("Remove sport Baseball"));
    await m.scrollUntilVisible(m.id(`Cards for Gm${TOKEN}`), { centerElement: true, timeout: 7_000 });
    await m.assertVisible(m.within(m.id(`Cards for Gm${TOKEN}`), `#316-${env.ATTEMPT_ID}`));
    await m.assertNotVisible(m.within(m.id(`Cards for Gm${TOKEN}`), "Baseball"));

    // ── Cleanup: delete the card ──
    await drillToSet();
    await m.scrollUntilVisible(m.id(`Delete card 316-${env.ATTEMPT_ID}(, .*)?`), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id(`Delete card 316-${env.ATTEMPT_ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 316-${env.ATTEMPT_ID}(, .*)?`));
    await m.waitNotVisible(m.id(`Edit card 316-${env.ATTEMPT_ID}(, .*)?`), 7_000);
  },
);
