// Port of .maestro/flows/set-selector/variation-link-group-and-unlink.yaml
import { test } from "../../support/fixtures";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";

test(
  "Card variations — point a card at the card it varies, see it group under it, and unlink it back out",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const ID = env.ATTEMPT_ID;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    // THE PARENT — #700
    await utilAddCustomCard(m, {
      SET_NAME: `cvar-${env.WORKER_INDEX}`,
      VARIANT_TYPE: "Insert",
      INSERT_NAME: "Base",
      CARD_NUMBER: `700-${ID}`,
      PLAYER_NAME: `Base Player ${ID}`,
    });

    // THE VARIATION — #701, added inline
    await m.scrollUntilVisible(m.id("Open add card form"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 7_000);

    await m.inputText(`701-${ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Variation Player ${ID}`);

    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));

    await m.scrollUntilVisible(m.id(`Edit card 701-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });

    await m.assertVisible(`#700-${ID}`);
    await m.assertVisible(`#701-${ID}`);

    // LINK
    await m.tapOn(m.id(`Edit card 701-${ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 7_000);

    // PORT-GAP: Maestro's swipes at x=80% scroll the drawer's inner scroller; the driver's swipe only
    // scrolls the window. The wait below is Playwright-visible regardless and the tap scrolls it into view.
    await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
    await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
    await m.waitVisible(m.id("Card number this one is a variation of"), 7_000);

    await m.tapOn(m.id("Card number this one is a variation of"));
    await m.inputText(`700-${ID}`);
    await m.pressKey("Enter");

    await m.waitVisible(m.id("Clear variation parent"), 7_000);
    await m.assertVisible(`.*#700-${ID} Base Player ${ID}.*`);

    // GROUPED
    await m.tapOn(m.id("Close card detail"));
    await m.waitNotVisible(m.id("Card name"), 7_000);

    await m.assertNotVisible(`#701-${ID}`);

    await m.scrollUntilVisible(m.id(`Show 1 variation of card 700-${ID}(, .*)?`), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.assertVisible(".*1 variation.*");

    // EXPAND / COLLAPSE
    await m.tapOn(m.id(`Show 1 variation of card 700-${ID}(, .*)?`));
    await m.waitVisible(`#701-${ID}`, 7_000);
    await m.assertVisible(m.id(`Hide 1 variation of card 700-${ID}(, .*)?`));

    await m.tapOn(m.id(`Hide 1 variation of card 700-${ID}(, .*)?`));
    await m.waitNotVisible(`#701-${ID}`, 7_000);

    await m.tapOn(m.id(`Show 1 variation of card 700-${ID}(, .*)?`));
    await m.waitVisible(`#701-${ID}`, 7_000);

    // UNLINK
    await m.scrollUntilVisible(m.id(`Edit card 701-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Edit card 701-${ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
    await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
    await m.waitVisible(m.id("Clear variation parent"), 7_000);
    await m.tapOn(m.id("Clear variation parent"));

    await m.waitVisible(m.id("Card number this one is a variation of"), 7_000);
    await m.tapOn(m.id("Close card detail"));
    await m.waitNotVisible(m.id("Card name"), 7_000);

    await m.waitVisible(`#701-${ID}`, 7_000);
    await m.assertNotVisible(m.id(`Show 1 variation of card 700-${ID}(, .*)?`));
    await m.assertNotVisible(m.id(`Hide 1 variation of card 700-${ID}(, .*)?`));

    // CLEANUP
    await m.scrollUntilVisible(m.id(`Delete card 701-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 701-${ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 701-${ID}(, .*)?`));
    await m.waitNotVisible(`#701-${ID}`, 7_000);

    await m.scrollUntilVisible(m.id(`Delete card 700-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 700-${ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 700-${ID}(, .*)?`));
    await m.waitNotVisible(`#700-${ID}`, 7_000);
  },
);
