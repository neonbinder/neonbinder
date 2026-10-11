// Port of .maestro/flows/set-selector/custom-card-crud.yaml
import { test } from "../../support/fixtures";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";

test(
  "Custom card lifecycle — add a card by hand, rename it, delete it",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const ID = env.ATTEMPT_ID;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilAddCustomCard(m, {
      SET_NAME: `ccrud-${env.WORKER_INDEX}`,
      VARIANT_TYPE: "Insert",
      INSERT_NAME: "Base",
      CARD_NUMBER: `999-${ID}`,
      PLAYER_NAME: `Test Player ${ID}`,
      CARD_NAME: `CRUDName-${ID}`,
    });

    await m.assertVisible(`#999-${ID}`);
    await m.assertVisible(`CRUDName-${ID}`);
    await m.assertVisible(m.id(`Edit card 999-${ID}(, .*)?`));

    await m.tapOn(m.id(`Edit card 999-${ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 15_000);
    await m.tapOn(m.id("Card name"));
    await m.eraseText(40);
    await m.inputText(`Renamed-${ID}`);
    await m.pressKey("Enter");
    await m.waitVisible(".*Saved Card name.*", 7_000);

    await m.assertVisible(m.id("Done editing card"));
    await m.tapOn(m.id("Done editing card"));

    await m.scrollUntilVisible(`Renamed-${ID}`, { centerElement: true, timeout: 7_000 });
    await m.assertNotVisible(`CRUDName-${ID}`);

    await m.scrollUntilVisible(m.id(`Delete card 999-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 999-${ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 999-${ID}(, .*)?`));
    await m.assertNotVisible(`Renamed-${ID}`);
  },
);
