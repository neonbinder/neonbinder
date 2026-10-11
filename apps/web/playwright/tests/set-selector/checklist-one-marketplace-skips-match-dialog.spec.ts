// Port of .maestro/flows/set-selector/checklist-one-marketplace-skips-match-dialog.yaml
import { test, expect } from "../../support/fixtures";
import { mrx } from "../../support/maestro";
import { utilDrillToColdRealSet } from "../../support/subflows/set-selector/util-drill-to-cold-real-set";

test(
  "Checklist — a set with exactly ONE marketplace attached skips the Match Cards dialog and keeps every fetched card",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const SET = "Roanoke Express ECHL";
    const YEAR = "1995";
    const SL_PAUSED = env.SL_PAUSED;

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToColdRealSet(m, { SPORT: "Hockey", YEAR, MANUFACTURER: "All Brands" });

    await m.waitVisible(m.id("Sets"), 15_000);
    await m.scrollUntilVisible(".*Search sets.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search sets.*");
    await m.inputText(SET);
    await m.retry(1, async () => {
      await m.tapOn(m.below(SET, m.id("Search sets")));
      await m.waitVisible("Variant Types", 20_000);
    });

    await m.assertVisible(m.id("Manufacturers: Unknown — change"));

    await m.waitVisible("Base", 60_000);

    await m.retry(1, async () => {
      await m.tapOn("Base");
      await m.waitVisible("Select Base Set", 7_000);
    });

    await m.waitVisible("Confirm Base Set", 60_000);

    await m.assertVisible(m.id("BSC base candidate: .*"));
    if (!SL_PAUSED) {
      await m.assertVisible(m.id("SportLots base candidate: .*"));
    }
    if (SL_PAUSED) {
      await m.assertVisible("SportLots returned no base set for .*");
      await m.assertNotVisible(m.id("SportLots base candidate: .*"));
    }

    await m.tapOn("Cancel");
    await m.assertVisible(".*Base mapping cancelled.*");
    await m.tapOn("Close");
    await m.waitNotVisible(".*Base mapping cancelled.*", 7_000);
    await m.assertVisible("Map Base Set");

    await m.scrollUntilVisible("Map Base Set", { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("Add Card", { centerElement: true, timeout: 7_000 });

    await m.assertVisible("No cards in this checklist yet.");
    await m.tapOn(m.id("Sync card checklist"));

    await m.waitVisible(".*Kept all [0-9]+ cards? from .*", 60_000);
    const keptText = await m.copyTextFrom(".*Kept all [0-9]+ cards? from .*");
    const FETCHED = keptText.match(/[0-9]+/)![0];
    expect(Number(FETCHED) > 0).toBe(true);

    await m.assertVisible(
      `.*Kept all ${FETCHED} cards? from BSC\\. Nothing to match, no other marketplace attached\\..*`,
    );

    await m.assertNotVisible("Match Cards.*");

    await m.waitVisible("Confirm New Players & Teams", 60_000);

    await m.assertNotVisible("Match Cards.*");
    await m.assertNotVisible("Back to matching");

    await m.retry(1, async () => {
      await m.tapOn(".*Skip remaining names \\([0-9]+\\).*");
      await m.waitVisible(".*Confirm & Save.*", 60_000);
    });

    await m.assertVisible(`.*All reviewed — save ${FETCHED} cards?.*`);

    await m.tapOn(".*Confirm & Save.*");

    await m.waitVisible(`.*Saved ${FETCHED} cards.*`, 60_000);

    await m.scrollUntilVisible(`.*Saved ${FETCHED} cards.*`, { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible(`.*[(]${FETCHED}[)].*`, { centerElement: true, timeout: 7_000 });

    await m.assertVisible("BSC only");
    await m.assertNotVisible("SL only");

    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card number"), 7_000);
    await m.inputText(`NB272-${env.ATTEMPT_ID}`);

    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));

    const edit = m.id(`Edit card NB272-${env.ATTEMPT_ID}(, .*)?`);
    await m.scrollUntilVisible(edit, { centerElement: true, timeout: 7_000 });

    await m.retry(1, async () => {
      await m.tapOn(edit);
      await m.waitVisible(m.id("Card title"), 7_000);
    });

    // id "Card title" + text: the input's stored value
    const title = await m.resolve(m.id("Card title"));
    await expect(title).toHaveValue(mrx(`.*${SET}.*`), { timeout: 7_000 });
    await expect(title).not.toHaveValue(mrx(".*Unknown.*"), { timeout: 7_000 });
    await expect(title).not.toHaveValue(mrx(".*All Brands.*"), { timeout: 7_000 });
  },
);
