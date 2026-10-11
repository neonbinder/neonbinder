// Port of .maestro/flows/set-selector/cross-release-unlink-keeps-card-in-home-set.yaml
import { test } from "../../support/fixtures";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";
import { utilCrossListCards } from "../../support/subflows/set-selector/util-cross-list-cards";

test(
  "Cross-release — 'Unlink' removes a visiting card from this checklist without deleting it from the set it was printed in",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const W = env.WORKER_INDEX;
    const ID = env.ATTEMPT_ID;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilAddCustomCard(m, {
      SET_NAME: `xds-${W}`,
      VARIANT_TYPE: "Insert",
      INSERT_NAME: "Base",
      CARD_NUMBER: `957-${ID}`,
      PLAYER_NAME: `Cross Unlink ${ID}`,
    });

    await utilDrillToCustom(m, {
      SPORT: `E2E Test Sport ${W}`,
      YEAR: "2026",
      MANUFACTURER: "Topps",
      SET_NAME: `xdg-${W}`,
      VARIANT_TYPE: "Insert",
      VARIANT: "Base",
    });

    await utilCrossListCards(m, { SOURCE_SET: `xds-${W}`, CARD_NUMBERS: `957-${ID}` });
    await m.assertVisible(".*Linked 1 card.*");
    await m.tapOn(m.id("Cancel cross-release import"));
    await m.waitNotVisible(m.id("Add cross-release cards"), 7_000);

    await m.scrollUntilVisible(`#957-${ID}`, { centerElement: true, timeout: 7_000 });

    await m.scrollUntilVisible("Unlink", { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Remove card 957-${ID}(, .*)? from this set`));

    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm remove card 957-${ID}(, .*)? from this set`));

    await m.waitNotVisible(`#957-${ID}`, 7_000);
    await m.scrollUntilVisible("No cards in this checklist yet.", { timeout: 7_000 });

    await m.assertNotVisible(m.id("Hide cross-release cards"));

    // The card still lives in its home set.
    await utilDrillToCustom(m, {
      SPORT: `E2E Test Sport ${W}`,
      YEAR: "2026",
      MANUFACTURER: "Topps",
      SET_NAME: `xds-${W}`,
      VARIANT_TYPE: "Insert",
      VARIANT: "Base",
    });

    await m.scrollUntilVisible(`#957-${ID}`, { centerElement: true, timeout: 7_000 });
    await m.assertVisible(`Cross Unlink ${ID}`);

    const del = m.id(`Delete card 957-${ID}(, .*)?`);
    await m.scrollUntilVisible(del, { centerElement: true, timeout: 7_000 });
    await m.tapOn(del);
    await m.tapOn(m.id(`Confirm delete card 957-${ID}(, .*)?`));
    await m.waitNotVisible(`#957-${ID}`, 7_000);
  },
);
