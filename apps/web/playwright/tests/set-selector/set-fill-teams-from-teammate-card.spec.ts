// Port of .maestro/flows/set-selector/set-fill-teams-from-teammate-card.yaml
import { test } from "../../support/fixtures";
import { idWithText } from "../../support/value-selectors";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

test(
  "Fill teams — a teamless card borrows the team its player carries on another card of the same set, from the checklist's N-cards-need-a-team button, after a preview the operator confirms (NEO-279, NEO-306)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const ID = env.ATTEMPT_ID;
    const TOK = env.ATTEMPT_TOKEN;
    const W = env.WORKER_INDEX;
    const TEAM = `Loc${TOK} FTT${TOK}`;
    const EDIT_781 = `Edit card 781-${ID}(, .*)?`;
    const EDIT_782 = `Edit card 782-${ID}(, .*)?`;
    const BADGE_781 = `Card 781-${ID}(, .*)? needs attention: no team on this card yet`;
    const BADGE_782 = `Card 782-${ID}(, .*)? needs attention: no team on this card yet`;

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    // STEP 1 — drill to the set
    await utilDrillToCustom(m, {
      SPORT: `E2E Test Sport ${W}`,
      YEAR: "2026",
      MANUFACTURER: "Topps",
      SET_NAME: `ftl-${W}-${ID}`,
    });
    await m.assertVisible("Variant Types");

    // STEP 2 — Insert › Base beneath the set, card #781 with player + team
    await m.scrollUntilVisible(m.id("Add custom Variant Types"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Variant Types"));
    await m.assertVisible("Add Custom Entry");
    await m.inputText("Insert");
    await m.pressKey("Enter");
    await m.assertVisible(m.id("Create variant type"));
    await m.tapOn(m.id("Create variant type"));
    await m.waitNotVisible("Add Custom Entry", 7_000);
    await m.scrollUntilVisible("Insert", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn("Insert");
    await m.waitVisible("Inserts", 7_000);

    await m.scrollUntilVisible(m.id("Add custom Inserts"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Inserts"));
    await m.assertVisible("Add Custom Entry");
    await m.inputText("Base");
    await m.pressKey("Enter");
    await m.assertVisible(m.id("Create insert"));
    await m.tapOn(m.id("Create insert"));
    await m.waitNotVisible("Add Custom Entry", 7_000);
    await m.scrollUntilVisible("Base", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Base");
    await m.scrollUntilVisible(m.id("Open add card form"), { centerElement: true, timeout: 7_000 });

    // ── CARD #781
    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.inputText(`781-${ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Fill Alpha ${ID}`);

    await m.scrollUntilVisible(m.id("Add a player to the new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add a player to the new card"));
    await m.assertVisible(m.id("Find a player for the new card"));
    await m.tapOn(m.id("Find a player for the new card"));
    await m.inputText(`FTP${TOK}`);
    await m.assertVisible(m.id(`Create player FTP${TOK}`));
    await m.tapOn(m.id(`Create player FTP${TOK}`));
    await m.waitVisible(m.id(`Remove player FTP${TOK}`), 7_000);

    await m.tapOn(m.id("Card name"));
    await m.waitNotVisible(m.id("Find a player for the new card"), 7_000);

    await m.scrollUntilVisible(m.id("Add team"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add team"));
    await m.assertVisible(m.id("Search teams"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`FTT${TOK}`);
    await m.assertVisible(m.id(`New team FTT${TOK}`));
    await m.tapOn(m.id(`New team FTT${TOK}`));
    await m.assertVisible(`New team: FTT${TOK}`);
    await m.assertVisible(idWithText(m, "New team name", `FTT${TOK}`));
    await m.tapOn(m.id("New team location \\(optional\\)"));
    await m.inputText(`Loc${TOK}`);
    await m.tapOn(m.id("League"));
    await m.inputText("No lea");
    await m.tapOn("No league");
    await m.waitVisible(idWithText(m, "League", "No league"), 7_000);
    await m.tapOn(m.id(`Create team ${TEAM}`));
    await m.waitVisible(m.id(`Remove team ${TEAM}`), 7_000);

    await m.tapOn(m.id("Card name"));
    await m.waitNotVisible(m.id("Search teams"), 7_000);
    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.waitNotVisible(m.id("Card name"), 7_000);
    await m.scrollUntilVisible(m.id(EDIT_781), { centerElement: true, timeout: 7_000 });
    await m.waitVisible(TEAM, 7_000);
    await m.assertNotVisible(m.id(BADGE_781));

    // STEP 3 — card #782: same player, no team
    await m.scrollUntilVisible(m.id("Open add card form"), { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.inputText(`782-${ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Fill Bravo ${ID}`);

    await m.scrollUntilVisible(m.id("Add a player to the new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add a player to the new card"));
    await m.assertVisible(m.id("Find a player for the new card"));
    await m.tapOn(m.id("Find a player for the new card"));
    await m.inputText(`FTP${TOK}`);
    await m.waitVisible(m.id(`Add FTP${TOK}`), 7_000);
    await m.assertNotVisible(m.id(`Create player FTP${TOK}`));
    await m.tapOn(m.id(`Add FTP${TOK}`));
    await m.waitVisible(m.id(`Remove player FTP${TOK}`), 7_000);
    await m.tapOn(m.id("Card name"));
    await m.waitNotVisible(m.id("Find a player for the new card"), 7_000);
    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.waitNotVisible(m.id("Card name"), 7_000);
    await m.scrollUntilVisible(m.id(EDIT_782), { centerElement: true, timeout: 7_000 });
    await m.waitVisible(m.id(BADGE_782), 7_000);

    // STEP 4 — fill from the checklist header
    await m.scrollUntilVisible("1 card needs a team", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn("1 card needs a team");

    await m.waitVisible("Fill teams on 1 card\\?", 7_000);
    await m.assertVisible("1 from the same player's other cards here\\.");

    await m.assertVisible(m.id("Who gets which team"));
    await m.assertVisible(m.within(m.id("Who gets which team"), `FTP${TOK}`));
    await m.assertVisible(m.within(m.id("Who gets which team"), TEAM));
    await m.assertVisible(". 1 card . same player in this set");

    await m.tapOn("Yes, fill");
    await m.waitVisible("Filled teams on 1 card", 7_000);
    await m.assertNotVisible("Fill teams on 1 card\\?");
    await m.assertNotVisible("[0-9]+ cards? needs? a team");

    // STEP 5 — card #782 carries the borrowed team, its badge is gone
    await m.scrollUntilVisible(m.id(EDIT_782), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(EDIT_782));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.waitVisible(m.id(`Remove team ${TEAM}`), 7_000);
    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));

    await m.scrollUntilVisible(m.id(EDIT_782), { centerElement: true, timeout: 7_000 });
    await m.assertNotVisible(m.id(BADGE_782));
    await m.assertVisible(m.id(EDIT_781));
    await m.assertVisible(TEAM);

    // CLEANUP — delete this attempt's two cards
    await m.scrollUntilVisible(m.id(`Delete card 781-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 781-${ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 781-${ID}(, .*)?`));
    await m.assertNotVisible(`Fill Alpha ${ID}`);

    await m.scrollUntilVisible(m.id(`Delete card 782-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 782-${ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 782-${ID}(, .*)?`));
    await m.assertNotVisible(`Fill Bravo ${ID}`);
    await m.waitVisible("No cards in this checklist yet.", 7_000);
  },
);
