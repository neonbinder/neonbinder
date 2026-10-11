// Port of .maestro/flows/set-selector/signed-by-autofills-from-players.yaml
//
// PORT-GAP (swipes): the Maestro `swipe: x=80%` steps are TOUCH drags that
// scroll the card drawer's own inner scroller (a `fixed inset-0` portal). The
// driver's swipe() scrolls the WINDOW, so each swipe is ported (same
// coordinates, same count) but does not move the drawer body. Playwright
// scrolls a target into view before clicking it, so the taps still land; the
// swipes are positioning only here.
import { test } from "../../support/fixtures";
import { idWithText } from "../../support/value-selectors";
import { utilDrillToBaseVariant } from "../../support/subflows/set-selector/util-drill-to-base-variant";

test(
  "Signed By auto-fills from the card's players when Autographed flips None → On Card (real Topps Chrome Base, sole-writer)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const ID = env.ATTEMPT_ID;

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    // STEP 0 — drill to real 2024 Topps Chrome Base
    await utilDrillToBaseVariant(m);

    // STEP 0b — precondition: the Base checklist is already populated
    await m.assertVisible("Refresh");

    // STEP 1 — open a real Base card's detail drawer
    await m.scrollUntilVisible(m.id("Edit card 300(, .*)?"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Edit card 300(, .*)?"));
    await m.scrollUntilVisible(m.id("Card name"), { centerElement: true, timeout: 7_000 });
    await m.assertVisible(".*Card #300.*");

    // STEP 3 — set Signed By to a unique sentinel (editor expanded)
    await m.scrollUntilVisible(m.id("Show features editor"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Show features editor"));
    await m.assertVisible(m.id("Card features editor"));

    await m.swipe({ start: "80%, 60%", end: "80%, 38%" });

    await m.assertVisible(m.id("Value for Signed By"));
    await m.tapOn(m.id("Value for Signed By"));
    await m.eraseText(60);
    await m.inputText(`SBSENT-${ID}`);
    await m.pressKey("Enter");
    await m.waitVisible(idWithText(m, "Value for Signed By", `.*SBSENT-${ID}.*`), 7_000);

    // STEP 4 — collapse the editor so pos-7 Autographed becomes reachable
    await m.swipe({ start: "80%, 25%", end: "80%, 90%" });
    await m.assertVisible(m.id("Hide features editor"));
    await m.tapOn(m.id("Hide features editor"));
    await m.assertVisible(m.id("Show features editor"));

    // STEP 5 — normalise + flip Autographed (Sticker, Sticker, On Card)
    await m.swipe({ start: "80%, 70%", end: "80%, 35%" });
    await m.assertVisible(m.id(".*Value for Autographed: Auto \\(Sticker\\).*"));
    await m.tapOn(m.id(".*Value for Autographed: Auto \\(Sticker\\).*"));
    await m.tapOn(m.id(".*Value for Autographed: Auto \\(Sticker\\).*"));
    await m.tapOn(m.id(".*Value for Autographed: Auto \\(On Card\\).*"));

    // STEP 6 — re-expand the editor + assert the auto-fill landed on Signed By
    await m.swipe({ start: "80%, 25%", end: "80%, 90%" });
    await m.assertVisible(m.id("Show features editor"));
    await m.tapOn(m.id("Show features editor"));
    await m.assertVisible(m.id("Card features editor"));

    await m.swipe({ start: "80%, 60%", end: "80%, 38%" });

    await m.waitVisible(idWithText(m, "Value for Signed By", ".*Julio.*"), 7_000);
    await m.assertNotVisible(idWithText(m, "Value for Signed By", `.*SBSENT-${ID}.*`));

    // STEP 7 — close
    await m.assertVisible(m.id("Done editing card"));
    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));
  },
);
