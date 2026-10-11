// Port of .maestro/flows/set-selector/card-features-editor-toggle.yaml
import { test } from "../../support/fixtures";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";

test(
  "Regression — Show/Hide features editor toggle expands then collapses the CardFeaturesEditor, then the card deletes cleanly",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilAddCustomCard(m, { SET_NAME: `cft-${env.WORKER_INDEX}`, VARIANT_TYPE: "Insert", INSERT_NAME: "Base", CARD_NUMBER: `991-${env.ATTEMPT_ID}`, PLAYER_NAME: `Features Toggle Player ${env.ATTEMPT_ID}` });
    await m.assertVisible(m.id(`Edit card 991-${env.ATTEMPT_ID}(, .*)?`));
    await m.tapOn(m.id(`Edit card 991-${env.ATTEMPT_ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 15_000);
    await m.assertVisible(m.id("Show features editor"));
    await m.tapOn(m.id("Show features editor"));
    await m.assertVisible(m.id("Card features editor"));
    await m.tapOn(m.id("Hide features editor"));
    await m.assertNotVisible(m.id("Card features editor"));
    await m.assertVisible(m.id("Show features editor"));
    await m.assertVisible(m.id("Done editing card"));
    await m.tapOn(m.id("Done editing card"));
    await m.scrollUntilVisible(m.id(`Delete card 991-${env.ATTEMPT_ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 991-${env.ATTEMPT_ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 991-${env.ATTEMPT_ID}(, .*)?`));
    await m.assertNotVisible(`Features Toggle Player ${env.ATTEMPT_ID}`);
  },
);
