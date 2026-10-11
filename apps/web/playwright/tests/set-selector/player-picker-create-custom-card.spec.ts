// Port of .maestro/flows/set-selector/player-picker-create-custom-card.yaml
import { test } from "../../support/fixtures";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";

test(
  "Player picker — create a brand-new player and attach it to a CUSTOM card (the gap this closes); it persists across reopen",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const { ATTEMPT_ID, ATTEMPT_TOKEN } = env;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilAddCustomCard(m, {
      SET_NAME: `pp-${env.WORKER_INDEX}`,
      VARIANT_TYPE: "Insert",
      INSERT_NAME: "Base",
      CARD_NUMBER: `777-${ATTEMPT_ID}`,
      PLAYER_NAME: `Player Picker Card ${ATTEMPT_ID}`,
    });

    const edit = m.id(`Edit card 777-${ATTEMPT_ID}(, .*)?`);
    const swipe3 = async () => {
      await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
      await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
      await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
    };

    await m.assertVisible(edit);
    await m.tapOn(edit);
    await m.waitVisible(m.id("Card name"), 15_000);

    await swipe3();

    await m.assertVisible(m.id("Player picker"));
    await m.assertVisible(m.id("Add player"));

    await m.tapOn(m.id("Add player"));
    await m.assertVisible(m.id("Search players"));
    await m.tapOn(m.id("Search players"));
    await m.inputText(`NBPlayer${ATTEMPT_TOKEN}`);

    await m.assertVisible(m.id(`Create player NBPlayer${ATTEMPT_TOKEN}`));
    await m.tapOn(m.id(`Create player NBPlayer${ATTEMPT_TOKEN}`));

    await m.assertVisible(m.id(`Remove player NBPlayer${ATTEMPT_TOKEN}`));

    await m.waitVisible(".*Saved Players.*", 7_000);

    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));

    // Reopen
    await m.scrollUntilVisible(edit, { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn(edit);
    await m.waitVisible(m.id("Card name"), 15_000);

    await swipe3();

    await m.assertVisible(m.id(`Remove player NBPlayer${ATTEMPT_TOKEN}`));

    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));

    const del = m.id(`Delete card 777-${ATTEMPT_ID}(, .*)?`);
    await m.scrollUntilVisible(del, { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn(del);
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 777-${ATTEMPT_ID}(, .*)?`));
    await m.assertNotVisible(`Player Picker Card ${ATTEMPT_ID}`);
  },
);
