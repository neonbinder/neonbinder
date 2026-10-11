// Port of .maestro/flows/set-selector/cross-release-hide-toggle-filters-guest-cards.yaml
import { test } from "../../support/fixtures";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";
import { utilCrossListCards } from "../../support/subflows/set-selector/util-cross-list-cards";

test(
  "Cross-release — the 'Hide cross-release cards' filter collapses a checklist back to only its own cards, and restores them",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilAddCustomCard(m, { SET_NAME: `xsrc-${env.WORKER_INDEX}`, VARIANT_TYPE: "Insert", INSERT_NAME: "Base", CARD_NUMBER: `955-${env.ATTEMPT_ID}`, PLAYER_NAME: `Cross Filter ${env.ATTEMPT_ID}` });
    await utilDrillToCustom(m, { SPORT: `E2E Test Sport ${env.WORKER_INDEX}`, YEAR: "2026", MANUFACTURER: "Topps", SET_NAME: `xcg-${env.WORKER_INDEX}`, VARIANT_TYPE: "Insert", VARIANT: "Base" });
    await utilCrossListCards(m, { SOURCE_SET: `xsrc-${env.WORKER_INDEX}`, CARD_NUMBERS: `955-${env.ATTEMPT_ID}` });
    await m.assertVisible(".*Linked 1 card.*");
    await m.tapOn(m.id("Cancel cross-release import"));
    await m.waitNotVisible(m.id("Add cross-release cards"), 7_000);
    await m.scrollUntilVisible(`#955-${env.ATTEMPT_ID}`, { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible(m.id("Hide cross-release cards"), { centerElement: true, direction: "UP", timeout: 7_000 });
    await m.tapOn(m.id("Hide cross-release cards"));
    await m.waitNotVisible(`#955-${env.ATTEMPT_ID}`, 7_000);
    await m.assertVisible("No cards in this checklist yet.");
    await m.scrollUntilVisible(m.id("Hide cross-release cards \\(on\\)"), { centerElement: true, direction: "UP", timeout: 7_000 });
    await m.tapOn(m.id("Hide cross-release cards \\(on\\)"));
    await m.waitVisible(`#955-${env.ATTEMPT_ID}`, 7_000);
    await m.scrollUntilVisible(m.id(`Remove card 955-${env.ATTEMPT_ID}(, .*)? from this set`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Remove card 955-${env.ATTEMPT_ID}(, .*)? from this set`));
    await m.tapOn(m.id(`Confirm remove card 955-${env.ATTEMPT_ID}(, .*)? from this set`));
    await m.waitNotVisible(`#955-${env.ATTEMPT_ID}`, 7_000);
  },
);
