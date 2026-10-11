// Port of .maestro/flows/set-selector/team-picker.yaml
import { test, expect } from "../../support/fixtures";
import { mrx } from "../../support/maestro";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

test(
  "TeamPicker — chip add, remove, keyboard Enter, 'No matches' state, autosaved on the tap",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const { ATTEMPT_ID, ATTEMPT_TOKEN } = env;
    const W = env.WORKER_INDEX;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    const drill = () =>
      utilDrillToCustom(m, {
        SPORT: "Baseball",
        YEAR: "2024",
        MANUFACTURER: "Topps",
        SET_NAME: `tp-${W}`,
        VARIANT_TYPE: "Insert",
        VARIANT: "Base",
      });
    await drill();

    await m.scrollUntilVisible(m.id("Open add card form"), { centerElement: true, timeout: 7_000 });

    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 15_000);
    await m.inputText(`889-${ATTEMPT_ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Team Feature Player ${ATTEMPT_ID}`);
    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.assertVisible(`Team Feature Player ${ATTEMPT_ID}`);

    const edit = m.id(`Edit card 889-${ATTEMPT_ID}(, .*)?`);
    await m.scrollUntilVisible(edit, { centerElement: true, timeout: 7_000 });

    await m.tapOn(edit);
    await m.waitVisible(m.id("Card name"), 15_000);

    await m.assertVisible(m.id("Team picker"));
    await m.assertVisible(m.id("Add team"));

    await m.tapOn(m.id("Add team"));
    await m.assertVisible(m.id("Search teams"));

    await m.tapOn(m.id("Search teams"));
    await m.inputText(`TPT${ATTEMPT_TOKEN}`);
    await m.assertVisible(m.id(`New team TPT${ATTEMPT_TOKEN}`));

    await m.tapOn(m.id(`New team TPT${ATTEMPT_TOKEN}`));

    await m.assertVisible(`New team: TPT${ATTEMPT_TOKEN}`);
    // assertVisible: id + text (the input's value)
    const nameField = await m.resolve(m.id("New team name"));
    await expect(nameField).toHaveValue(mrx(`TPT${ATTEMPT_TOKEN}`), { timeout: 7_000 });

    await m.tapOn(m.id(`Create team TPT${ATTEMPT_TOKEN}`));

    await m.tapOn(m.id("Card name"));
    await m.assertVisible(m.id(`Remove team TPT${ATTEMPT_TOKEN}`));

    await m.tapOn(m.id(`Remove team TPT${ATTEMPT_TOKEN}`));
    await m.assertNotVisible(m.id(`Remove team TPT${ATTEMPT_TOKEN}`));

    await m.tapOn(m.id("Add team"));
    await m.assertVisible(m.id("Search teams"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText("ZZZZNOTATEAM");
    await m.assertVisible("No matches.");

    await m.tapOn(m.id("Card name"));

    await m.tapOn(m.id("Add team"));
    await m.assertVisible(m.id("Search teams"));
    await m.tapOn(m.id("Search teams"));
    await m.eraseText(20);
    await m.inputText(`TPT${ATTEMPT_TOKEN}`);
    await m.assertVisible(m.id(`Add TPT${ATTEMPT_TOKEN}( · .*)?`));

    await m.pressKey("Enter");

    await m.waitVisible(".*Saved Teams.*", 7_000);

    await m.tapOn(m.id("Card name"));

    await m.assertVisible(m.id(`Remove team TPT${ATTEMPT_TOKEN}`));

    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible("Card name");

    await m.tapOn(edit);
    await m.waitVisible(m.id("Card name"), 15_000);

    await m.assertVisible(m.id(`Remove team TPT${ATTEMPT_TOKEN}`));

    await m.tapOn(m.id("Done editing card"));
    await m.assertVisible(`Team Feature Player ${ATTEMPT_ID}`);

    await m.assertVisible(`.*TPT${ATTEMPT_TOKEN}.*`);

    // Re-drill: the team persisted on the card
    await drill();

    await m.scrollUntilVisible(`Team Feature Player ${ATTEMPT_ID}`, { timeout: 7_000 });
    await m.assertVisible(`.*TPT${ATTEMPT_TOKEN}.*`);

    await m.tapOn(m.id(`Delete card 889-${ATTEMPT_ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 889-${ATTEMPT_ID}(, .*)?`));
    await m.assertNotVisible(`Team Feature Player ${ATTEMPT_ID}`);
  },
);
