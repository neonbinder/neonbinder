// Port of .maestro/flows/set-selector/cross-release-card-appears-in-guest-checklist.yaml
import { test } from "../../support/fixtures";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";
import { utilCrossListCards } from "../../support/subflows/set-selector/util-cross-list-cards";

test(
  "Cross-release — a card printed in another product shows up in this set's checklist, badged with the set it came from",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const ID = env.ATTEMPT_ID;
    const W = env.WORKER_INDEX;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilAddCustomCard(m, {
      SET_NAME: `xsrc-${W}`,
      VARIANT_TYPE: "Insert",
      INSERT_NAME: "Base",
      CARD_NUMBER: `951-${ID}`,
      PLAYER_NAME: `Cross Home ${ID}`,
    });

    await utilDrillToCustom(m, {
      SPORT: `E2E Test Sport ${W}`,
      YEAR: "2026",
      MANUFACTURER: "Topps",
      SET_NAME: `xag-${W}`,
      VARIANT_TYPE: "Insert",
      VARIANT: "Base",
    });

    await utilCrossListCards(m, {
      SOURCE_SET: `xsrc-${W}`,
      CARD_NUMBERS: `951-${ID}`,
    });

    await m.assertVisible(".*Linked 1 card.*");

    await m.tapOn(m.id("Cancel cross-release import"));
    await m.waitNotVisible(m.id("Add cross-release cards"), 7_000);

    await m.scrollUntilVisible(`#951-${ID}`, { centerElement: true, timeout: 7_000 });

    await m.assertVisible(`.*2026 Topps xsrc-${W}.*`);

    await m.scrollUntilVisible(m.id(`Remove card 951-${ID}(, .*)? from this set`), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id(`Remove card 951-${ID}(, .*)? from this set`));
    await m.tapOn(m.id(`Confirm remove card 951-${ID}(, .*)? from this set`));
    await m.waitNotVisible(`#951-${ID}`, 7_000);
  },
);
