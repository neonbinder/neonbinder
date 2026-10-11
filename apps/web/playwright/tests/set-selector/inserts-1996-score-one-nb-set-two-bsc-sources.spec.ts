// Port of .maestro/flows/set-selector/inserts-1996-score-one-nb-set-two-bsc-sources.yaml
import { test } from "../../support/fixtures";
import type { Maestro } from "../../support/maestro";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";

const SCORE_1996 = {
  SPORT: "Baseball",
  YEAR: "1996",
  MANUFACTURER: "Score",
  SET: "Score",
  CREATE_MANUFACTURER: true,
};

/** Re-drill to 1996 Score, open Insert, and filter the Search inserts box to "Artist". */
async function redrillToInsertsFilteredToArtist(m: Maestro): Promise<void> {
  await utilDrillTo2024ToppsChrome(m, SCORE_1996);
  await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 7_000 });
  await m.tapOn("Insert");

  await m.waitVisible(".*Search inserts.*", 60_000);
  await m.scrollUntilVisible(".*Search inserts.*", { centerElement: true, timeout: 7_000 });
  await m.tapOn(".*Search inserts.*"); // waitToSettleTimeoutMs dropped
  await m.inputText("Artist");
}

test(
  "Inserts — ONE NeonBinder set maps to TWO BSC sets and one SportLots set, and a re-sync keeps NeonBinder's own card name (1996 Score, NEO-137 + NEO-203)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const A = env.ATTEMPT_ID;
    const SL_PAUSED = utilPausedPlatforms(m);

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillTo2024ToppsChrome(m, SCORE_1996);

    await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Insert");

    if (!SL_PAUSED) {
      // ── Reconcile: merge BSC Series 1 into the NB set "Series 2", rename it ──
      await m.waitVisible("Reconcile Inserts", 240_000);
      await m.assertVisible(".*Ready \\([0-9]+\\).*");

      await m.tapOn(m.id("Filter NeonBinder sets")); // waitToSettleTimeoutMs dropped
      await m.inputText("Artist");
      await m.waitVisible(".*Ready \\(1 of [0-9]+\\).*", 10_000);
      await m.assertVisible(".*Pending \\([0-9]+\\).*");

      await m.assertVisible(m.id("NeonBinder set name for Dugout Collection Artist's Proofs Series 2"));

      await m.tapOn(m.id("Filter BSC items")); // waitToSettleTimeoutMs dropped
      await m.inputText("Artist");
      await m.waitVisible(".*BSC \\(1 of [0-9]+\\).*", 15_000);

      await m.swipe({ start: "3%, 75%", end: "3%, 25%" });

      await m.tapOn("Dugout Collection Artist's Proofs Series 1"); // retryTapIfNoChange dropped
      await m.scrollUntilVisible(
        m.id("Add Dugout Collection Artist's Proofs Series 1 to this set, Dugout Collection Artist's Proofs Series 2"),
        { centerElement: true, timeout: 7_000 },
      );
      await m.tapOn(
        m.id("Add Dugout Collection Artist's Proofs Series 1 to this set, Dugout Collection Artist's Proofs Series 2"),
      );

      await m.waitVisible(".*BSC \\(0 of [0-9]+\\).*", 10_000);

      await m.tapOn(m.id("NeonBinder set name for Dugout Collection Artist's Proofs Series 2"));
      await m.eraseText(60);
      await m.inputText("Dugout Collection Artists Proofs");
      await m.pressKey("Enter");
      await m.waitVisible(m.id("NeonBinder set name for Dugout Collection Artists Proofs"), 10_000);

      await m.scrollUntilVisible(".*Save [0-9]+ sets.*", { timeout: 7_000 });
      await m.tapOn(".*Save [0-9]+ sets.*");
      await m.waitNotVisible("Reconcile Inserts", 7_000);

      // ── Re-drill: the merged set exists, the two raw BSC sets do not ──
      await redrillToInsertsFilteredToArtist(m);

      await m.waitVisible(m.below(".*Dugout Collection Artists Proofs.*", m.id("Search inserts")), 20_000);
      await m.assertNotVisible(".*Artist's Proofs Series [12].*");

      await m.tapOn(m.below(".*Dugout Collection Artists Proofs.*", m.id("Search inserts")));
      await m.scrollUntilVisible("Multi-source sets", { centerElement: true, timeout: 7_000 });

      await m.assertVisible(".*Dugout Collection Artist's Proofs Series 1.*");
      await m.assertVisible(".*Dugout Collection Artist's Proofs Series 2.*");
      await m.assertNotVisible(".*PRIMARY.*");

      // ── Fetch: Match Cards, then the new-entity wizard ──
      await m.scrollUntilVisible(".*Fetch from Marketplaces.*|Refresh", { centerElement: true, timeout: 7_000 });
      await m.tapOn(".*Fetch from Marketplaces.*|Refresh");

      if (!SL_PAUSED) {
        await m.waitVisible("Match Cards.*", 120_000);
        await m.waitVisible("^Confirm$", 120_000);

        await m.assertVisible(".*Match Cards — Dugout Collection Artists Proofs.*");
        await m.assertVisible(".*Unlink.*");
        await m.assertNotVisible(".*BSC only.*");
        await m.assertNotVisible(".*SportLots only.*");
        await m.assertNotVisible(".*Nothing kept.*");
        await m.assertVisible(".*220 cards will be saved.*");

        await m.tapOn(m.id("Confirm card matches"));
        await m.waitNotVisible("Match Cards.*", 60_000);
      }
      // Dead under the outer live guard in the original flow too (nested SL_PAUSED branch).
      if (SL_PAUSED) {
        await m.waitVisible(".*Kept all 220 cards from BSC.*", 120_000);
        await m.assertNotVisible("Match Cards.*");
      }

      await m.waitVisible("Confirm New Players & Teams", 120_000);
      await m.waitNotVisible(".*still looking up.*", 180_000);
      await m.waitVisible(m.id("^Add as New (Player|Team|League)$"), 30_000);
      await m.tapOn(m.id("^Add as New (Player|Team|League)$"));
      await m.tapOn("Cancel \\(Esc\\)"); // retryTapIfNoChange dropped; literal label, parens escaped
      await m.assertVisible("Discard 1 decision.*");
      await m.tapOn(m.below("Cancel", ".*The same names come back the next time you sync this set.*"));
      await m.assertVisible("Confirm New Players & Teams");
      await m.assertVisible("1 of [0-9]+ reviewed.*");

      await m.tapOn(".*Add remaining players as new.*");
      for (let i = 0; i < 250; i++) {
        if (!(await m.isNotVisible(".*Confirm & Save.*"))) break;
        if (await m.isVisible(m.id("^Add as New (Team|League)$"))) {
          await m.tapOn(m.id("^Add as New (Team|League)$"), { optional: true });
        }
      }
      await m.waitVisible(".*Confirm & Save.*", 240_000);
      await m.pressKey("Enter");

      await m.waitVisible(".*Saved 220 cards.*", 120_000);

      // ── NEO-203: a card name edited in NB survives a re-sync ──
      await m.scrollUntilVisible("BSC source", { centerElement: true, timeout: 7_000 });

      await m.retry(1, async () => {
        await m.tapOn(m.below(m.id("Edit card .*"), "BSC source")); // waitToSettleTimeoutMs dropped
        await m.waitVisible(m.id("Card name"), 15_000);
      });

      await m.tapOn(m.id("Card name"));
      await m.inputText(`NB203-${A}`);

      await m.pressKey("Enter");
      await m.waitVisible(".*Saved Card name.*", 7_000);

      await m.assertVisible(m.id("Done editing card"));
      await m.tapOn(m.id("Done editing card"));
      await m.assertNotVisible(m.id("Card name"));
      await m.assertVisible(m.below(`.*NB203-${A}.*`, "BSC source"));

      await m.scrollUntilVisible(m.id("Sync card checklist"), {
        direction: "UP",
        centerElement: true,
        timeout: 7_000,
      });
      await m.tapOn(m.id("Sync card checklist"));

      if (!SL_PAUSED) {
        await m.waitVisible("Match Cards.*", 120_000);
        await m.waitVisible("^Confirm$", 120_000);

        await m.assertVisible(".*220 cards will be saved.*");
        await m.tapOn(m.id("Confirm card matches"));
      }
      if (SL_PAUSED) {
        await m.waitVisible(
          ".*Kept all 220 cards from BSC.*|.*Review Changes — Dugout Collection Artists Proofs.*",
          120_000,
        );
        await m.assertNotVisible("Match Cards.*");
      }

      await m.waitVisible(".*Review Changes — Dugout Collection Artists Proofs.*", 7_000);

      await m.assertVisible(".*Content changes \\(1\\).*");
      await m.assertVisible("Card name");
      await m.assertVisible(m.below(`.*NB203-${A}.*`, "Card name"));
      await m.assertVisible(".* 0 new .*unchanged.*");
      await m.assertNotVisible(".*no longer listed upstream.*");

      await m.tapOn(m.id("Apply selected changes"));

      await m.waitVisible(".*Saved 220 cards.*", 120_000);

      await m.scrollUntilVisible("BSC source", { centerElement: true, timeout: 7_000 });
      await m.assertVisible(m.below(`.*NB203-${A}.*`, "BSC source"));

      // ── NEO-211: rename the set, re-sync Inserts, reconcile keeps the rename ──
      await m.scrollUntilVisible(".*Attributes for Dugout Collection Artists Proofs.*", {
        direction: "UP",
        centerElement: true,
        timeout: 7_000,
      });
      await m.tapOn(m.id("Rename Dugout Collection Artists Proofs"));
      await m.waitVisible(m.id("Edit name for Dugout Collection Artists Proofs"), 7_000);
      await m.tapOn(m.id("Edit name for Dugout Collection Artists Proofs")); // waitToSettleTimeoutMs dropped
      await m.inputText(`Dugout Collection Artists Proofs NB211-${A}`);
      await m.pressKey("Enter");

      await m.scrollUntilVisible(`.*Attributes for Dugout Collection Artists Proofs NB211-${A}.*`, {
        centerElement: true,
        timeout: 7_000,
      });

      await m.scrollUntilVisible("Sync Inserts", { direction: "UP", centerElement: true, timeout: 7_000 });
      await m.tapOn("Sync Inserts");

      await m.waitVisible("Reconcile Inserts", 240_000);

      await m.tapOn(m.id("Filter NeonBinder sets")); // waitToSettleTimeoutMs dropped
      await m.inputText(`NB211-${A}`);
      await m.waitVisible(".*Ready \\(1 of [0-9]+\\).*", 10_000);
      await m.assertVisible(m.id(`NeonBinder set name for Dugout Collection Artists Proofs NB211-${A}`));

      await m.scrollUntilVisible(".*Save [0-9]+ sets.*", { timeout: 7_000 });
      await m.tapOn(".*Save [0-9]+ sets.*");
      await m.waitNotVisible("Reconcile Inserts", 7_000);

      // ── Re-drill: the renamed set is there, the raw BSC names are not ──
      await redrillToInsertsFilteredToArtist(m);

      await m.waitVisible(
        m.below(`.*Dugout Collection Artists Proofs NB211-${A}.*`, m.id("Search inserts")),
        20_000,
      );
      await m.assertNotVisible(".*Artist.s Proofs Series [12].*");

      // ── NEO-211: Name Check — keep mine, decline BSC's (and SportLots's) names ──
      await m.scrollUntilVisible(m.id(".*names? to check — review suggestions"), {
        centerElement: true,
        timeout: 7_000,
      });
      await m.tapOn(m.id(".*names? to check — review suggestions"));

      await m.waitVisible("Name Check — Inserts", 7_000);

      if (!SL_PAUSED) {
        await m.assertVisible('.*SportLots calls it "Dugout Collection Artists Proofs".*');
        await m.assertVisible('.*BSC calls it "Dugout Collection Artist.s Proofs Series [12]".*');
      }
      if (SL_PAUSED) {
        await m.assertVisible('.*BSC calls it "Dugout Collection Artist.s Proofs Series [12]".*');
        await m.assertNotVisible(".*SportLots calls it.*");
      }

      await m.tapOn(
        m.id(
          `Keep mine — keep "Dugout Collection Artists Proofs NB211-${A}"; stop suggesting BSC's ".*"`,
        ),
      );
      if (!SL_PAUSED) {
        await m.tapOn(
          m.id(
            `Keep mine — keep "Dugout Collection Artists Proofs NB211-${A}"; stop suggesting SportLots's ".*"`,
          ),
        );

        await m.assertVisible("0 to take · 2 to keep");
        await m.tapOn(m.id("Apply decisions"));
        await m.waitVisible("2 declined", 7_000);
      }
      // Dead under the outer live guard in the original flow too (nested SL_PAUSED branch).
      if (SL_PAUSED) {
        await m.assertVisible("0 to take · 1 to keep");
        await m.tapOn(m.id("Apply decisions"));
        await m.waitVisible("1 declined", 7_000);
      }

      await m.assertVisible(m.below(`.*Dugout Collection Artists Proofs NB211-${A}.*`, m.id("Search inserts")));

      // ── NEO-137: detach a source — Cancel leaves both sources attached ──
      await m.tapOn(m.below(`.*Dugout Collection Artists Proofs NB211-${A}.*`, m.id("Search inserts")));

      await m.scrollUntilVisible("Multi-source sets", { centerElement: true, timeout: 7_000 });
      await m.assertVisible(".*Dugout Collection Artist.s Proofs Series 1.*");
      await m.assertVisible(".*Dugout Collection Artist.s Proofs Series 2.*");

      await m.scrollUntilVisible(".*Dugout Collection Artist.s Proofs Series 1.*", {
        centerElement: true,
        timeout: 7_000,
      });
      await m.tapOn(m.id("Remove Dugout Collection Artist.s Proofs Series 1"));

      await m.waitVisible(".*110 cards were fetched from it; their BSC link will be dropped.*", 7_000);

      await m.tapOn(m.id("Cancel detach Dugout Collection Artist.s Proofs Series 1"));
      await m.waitNotVisible(".*were fetched from it.*", 7_000);

      await m.assertVisible(".*Dugout Collection Artist.s Proofs Series 1.*");
      await m.assertVisible(".*Dugout Collection Artist.s Proofs Series 2.*");
    }

    if (SL_PAUSED) {
      // ── Paused branch: BSC-only, nothing to reconcile ──
      await m.waitVisible(m.id("Inserts"), 240_000);
      await m.assertNotVisible("Reconcile Inserts");
      await m.tapOn(".*Search inserts.*"); // waitToSettleTimeoutMs dropped
      await m.inputText("Artist");
      await m.waitVisible(m.below(".*Dugout Collection Artist.s Proofs Series 1.*", m.id("Search inserts")), 7_000);
      await m.assertVisible(m.below(".*Dugout Collection Artist.s Proofs Series 2.*", m.id("Search inserts")));
      await m.assertVisible("BSC");
      await m.assertNotVisible("SL");
    }
  },
);
