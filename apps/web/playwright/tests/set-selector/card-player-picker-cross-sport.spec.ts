// Port of .maestro/flows/set-selector/card-player-picker-cross-sport.yaml
import { test } from "../../support/fixtures";
import { pickNativeOption } from "../../support/subflows/native-select";
import { utilAddPlayerByHand } from "../../support/subflows/admin/util-add-player-by-hand";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

test(
  "Card player picker — switch the search to Football and put a football player on a baseball card; the card carries him with his sport, and he stays out of Baseball's roster (NEO-313)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const TOKEN = env.ATTEMPT_TOKEN;
    const ATTEMPT_ID = env.ATTEMPT_ID;
    const W = env.WORKER_INDEX || 0;
    const drill = {
      SPORT: "Baseball",
      YEAR: "2024",
      MANUFACTURER: "Topps",
      SET_NAME: `xsp-${W}`,
      VARIANT_TYPE: "Insert",
      VARIANT: "Base",
    };

    await m.launch(m.signInUrl("/admin/players"));
    await m.waitVisible(".*of .* players.*", 45_000);

    // STEP 1 — the football player
    await utilAddPlayerByHand(m, { PLAYER_NAME: `Gp${TOKEN}`, SPORT: "Football" });

    // STEP 2 — a baseball card's add form
    await utilDrillToCustom(m, drill);
    await m.scrollUntilVisible(m.id("Open add card form"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.inputText(`315-${ATTEMPT_ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Guest Card ${ATTEMPT_ID}`);

    // STEP 3 — the default search, then the switch
    await m.scrollUntilVisible(m.id("Add a player to the new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add a player to the new card"));
    await m.tapOn(m.id("Find a player for the new card"));
    await m.inputText(`Gp${TOKEN}`);

    await m.waitVisible(m.id(`Create player Gp${TOKEN}`), 7_000);
    await m.assertVisible(m.id("Sport to search for players: Baseball"));
    await m.tapOn(m.id("Sport to search for players: Baseball"));
    await m.waitVisible(m.id("Choose a sport"), 7_000);
    await m.inputText("F");
    await m.scrollUntilVisible(m.within(m.id("Choose a sport"), "Football"), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.within(m.id("Choose a sport"), "Football"));
    await m.waitVisible(m.id("Sport to search for players: Football"), 7_000);

    await m.waitVisible(m.id(`Add Gp${TOKEN}`), 7_000);
    await m.tapOn(m.id(`Add Gp${TOKEN}`));
    await m.waitVisible(m.id(`Remove player Gp${TOKEN}`), 7_000);
    await m.waitVisible(m.within(m.id("Players on the new card"), "Football"), 7_000);

    await m.tapOn(m.id("Card name"));
    await m.waitNotVisible(m.id("Find a player for the new card"), 7_000);

    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.waitNotVisible(m.id("Card name"), 7_000);

    // STEP 4 — read it back from the Players admin
    await m.openLink("/admin/players");
    await m.waitVisible(".*of .* players.*", 20_000);

    await m.tapOn("Filter players");
    await m.inputText(`Gp${TOKEN}`);
    await m.waitVisible(".*matches.*", 7_000);
    // tapOn "All sports" + tapOn "Baseball" (native select open-then-pick)
    await pickNativeOption(m, "Baseball");
    await m.waitVisible("No players match that filter.", 7_000);
    await m.assertVisible("0 matches");
    // tapOn "Baseball" + tapOn "Football"
    await pickNativeOption(m, "Football");
    await m.waitVisible(m.below(`Gp${TOKEN}`, ".*matches.*"), 7_000);

    await m.tapOn(m.below(`Gp${TOKEN}`, ".*matches.*"));
    await m.scrollUntilVisible(m.id(`Cards for Gp${TOKEN}`), { centerElement: true, timeout: 7_000 });
    await m.assertVisible(m.within(m.id(`Cards for Gp${TOKEN}`), `#315-${ATTEMPT_ID}`));
    await m.assertVisible(m.within(m.id(`Cards for Gp${TOKEN}`), "Baseball"));

    // STEP 5 — reopen the card, then delete it
    await utilDrillToCustom(m, drill);
    await m.scrollUntilVisible(m.id(`Edit card 315-${ATTEMPT_ID}(, .*)?`), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id(`Edit card 315-${ATTEMPT_ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 7_000);

    await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
    await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
    await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
    await m.assertVisible(m.id(`Remove player Gp${TOKEN}`));
    await m.waitVisible(m.within(m.id("Player picker"), "Football"), 7_000);

    await m.tapOn(m.id("Done editing card"));
    await m.waitNotVisible(m.id("Card name"), 7_000);

    await m.scrollUntilVisible(m.id(`Delete card 315-${ATTEMPT_ID}(, .*)?`), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id(`Delete card 315-${ATTEMPT_ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 315-${ATTEMPT_ID}(, .*)?`));
    await m.waitNotVisible(m.id(`Edit card 315-${ATTEMPT_ID}(, .*)?`), 7_000);
  },
);
