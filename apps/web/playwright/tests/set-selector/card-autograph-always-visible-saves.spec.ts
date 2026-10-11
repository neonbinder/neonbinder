// Port of .maestro/flows/set-selector/card-autograph-always-visible-saves.yaml
import { test } from "../../support/fixtures";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";

test(
  "Card detail — the unified Autographed control is always-visible (promoted out of Show features), not gated behind the features editor",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilAddCustomCard(m, {
      SET_NAME: `cag-${env.WORKER_INDEX}`,
      VARIANT_TYPE: "Insert",
      INSERT_NAME: "Base",
      CARD_NUMBER: `778-${env.ATTEMPT_ID}`,
      PLAYER_NAME: `Autograph Test Player ${env.ATTEMPT_ID}`,
    });

    const edit = m.id(`Edit card 778-${env.ATTEMPT_ID}(, .*)?`);
    await m.assertVisible(edit);
    await m.tapOn(edit);
    await m.waitVisible(m.id("Card name"), 15_000);

    await m.assertVisible(m.id("Show features editor"));

    await m.swipe({ start: "80%, 70%", end: "80%, 35%" });

    await m.assertVisible(m.id(".*Value for Autographed: Auto \\(On Card\\).*"));

    await m.assertVisible(m.id("Done editing card"));
    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));

    const del = m.id(`Delete card 778-${env.ATTEMPT_ID}(, .*)?`);
    await m.scrollUntilVisible(del, { centerElement: true, timeout: 7_000 });
    await m.tapOn(del);
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 778-${env.ATTEMPT_ID}(, .*)?`));
    await m.assertNotVisible(`Autograph Test Player ${env.ATTEMPT_ID}`);
  },
);
