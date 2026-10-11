// Port of .maestro/flows/set-selector/bowman-insert-grouping-builds-parallels.yaml
import { test, expect } from "../../support/fixtures";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

test(
  "2026 Bowman inserts — BSC's inserts become NB sets, Group Parallels nests Anime Kanji under Anime, and saving Anime builds Kanji's cards (NEO-293…312)",
  { tag: ["@set-selector", "@parallel-grouping"] },
  async ({ m }) => {
    const SL_PAUSED = utilPausedPlatforms(m);
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilDrillTo2024ToppsChrome(m, { SPORT: "Baseball", YEAR: "2026", MANUFACTURER: "Bowman", SET: "Bowman" });
    await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Insert");
    if (!SL_PAUSED) {
      await m.scrollUntilVisible("Sync Inserts", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Sync Inserts");
      await m.waitVisible("Reconcile Inserts", 240_000);
      await m.tapOn(m.id("Filter NeonBinder sets"));
      await m.inputText("Anime");
      await m.tapOn(m.id("Filter BSC items"));
      await m.inputText("Anime");
      await m.waitVisible(m.id("NeonBinder set name for Anime$|Make its own set: Anime$"), 7_000);
      if (await m.isVisible(m.id("Make its own set: Anime$"))) {
        await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
        await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
        await m.swipe({ start: "3%, 75%", end: "3%, 25%" });
        await m.tapOn(m.id("Make its own set: Anime$"));
        await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
        await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      }
      await m.waitVisible(m.id("NeonBinder set name for Anime$"), 7_000);
      await m.waitVisible(m.id("NeonBinder set name for Anime Kanji|Make its own set: Anime Kanji$"), 7_000);
      await m.waitVisible(m.id("Keep all [1-9][0-9]*, BSC sets?"), 7_000);
      await m.swipe({ start: "3%, 75%", end: "3%, 50%" });
      await m.tapOn(m.id("Clear filter bsc items"));
      await m.waitVisible("BSC \\([1-9][0-9]*\\)", 7_000);
      const readyText = await m.copyTextFrom("[0-9]+ ready, [0-9]+ pending");
      const READY_BEFORE = Number(readyText.split(" ")[0]);
      const keepAllText = await m.copyTextFrom("BSC \\([1-9][0-9]*\\)");
      const KEEP_ALL_N = Number(keepAllText.split("(")[1].split(")")[0]);
      expect(READY_BEFORE > 0 && KEEP_ALL_N > 0).toBe(true);
      await m.tapOn(m.id("Keep all(?: [1-9][0-9]*)?, BSC sets?"));
      await m.waitVisible(`${READY_BEFORE + KEEP_ALL_N} ready, [0-9]+ pending`, 7_000);
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.waitVisible(m.id("NeonBinder set name for Anime Kanji"), 7_000);
      await m.assertVisible(m.id("NeonBinder set name for Anime$"));
      await m.scrollUntilVisible(".*Save [0-9]+ sets.*", { timeout: 7_000 });
      await m.tapOn(".*Save [0-9]+ sets.*");
      await m.waitNotVisible("Reconcile Inserts", 7_000);
      await utilDrillTo2024ToppsChrome(m, { SPORT: "Baseball", YEAR: "2026", MANUFACTURER: "Bowman", SET: "Bowman" });
      await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 7_000 });
      await m.tapOn("Insert");
    }
    if (SL_PAUSED) {
      await m.waitVisible(m.id("Inserts"), 240_000);
      await m.assertNotVisible("Reconcile Inserts");
    }
    await m.waitVisible(".*Search inserts.*", 7_000);
    await m.scrollUntilVisible(".*Search inserts.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search inserts.*");
    await m.inputText("Anime");
    await m.waitVisible(m.below("^Anime$", m.id("Search inserts")), 7_000);
    await m.assertVisible(m.below("^Anime Kanji$", m.id("Search inserts")));
    await m.scrollUntilVisible("Group Parallels", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Group Parallels");
    await m.waitVisible(".*Drag inserts under a parent.*", 7_000);
    await m.scrollUntilVisible("Accept all suggestions \\((20[1-9]|2[1-9][0-9]|[3-9][0-9][0-9]|[1-9][0-9]{3,})\\)", { timeout: 7_000 });
    await m.tapOn("Accept all suggestions \\([0-9]+\\)");
    await m.assertVisible("(20[1-9]|2[1-9][0-9]|[3-9][0-9][0-9]|[1-9][0-9]{3,}) promotions, 0 demotions");
    await m.scrollUntilVisible("Save (20[1-9]|2[1-9][0-9]|[3-9][0-9][0-9]|[1-9][0-9]{3,}) changes", { timeout: 7_000 });
    await m.tapOn("Save [0-9]+ changes");
    await m.waitNotVisible(".*Drag inserts under a parent.*", 7_000);
    await utilDrillTo2024ToppsChrome(m, { SPORT: "Baseball", YEAR: "2026", MANUFACTURER: "Bowman", SET: "Bowman" });
    await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Insert");
    await m.waitVisible(".*Search inserts.*", 7_000);
    await m.scrollUntilVisible(".*Search inserts.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search inserts.*");
    await m.inputText("Anime");
    await m.waitVisible(m.below("^Anime$", m.id("Search inserts")), 7_000);
    await m.assertNotVisible(m.below("^Anime Kanji$", m.id("Search inserts")));
    await m.scrollUntilVisible("Group Parallels", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Group Parallels");
    await m.waitVisible(".*Drag inserts under a parent.*", 7_000);
    await m.waitVisible(m.id("Select .+"), 7_000);
    await m.assertVisible("No changes yet");
    await m.assertNotVisible("Accept all suggestions \\([0-9]+\\)");
    await m.tapOn("Cancel");
    await m.waitNotVisible(".*Drag inserts under a parent.*", 7_000);
    await m.scrollUntilVisible("Sync Inserts", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Sync Inserts");
    if (!SL_PAUSED) {
      await m.waitVisible("Reconcile Inserts", 240_000);
    }
    if (SL_PAUSED) {
      await m.waitVisible("Stored [0-9]+ variants \\(single platform\\)|Some variants were not stored.*|Sync failed: could not load variants.*", 240_000);
    }
    await m.waitVisible("[0-9]+ already grouped as (a parallel|parallels)\\. Leaving (it|those) be\\.", 7_000);
    await m.assertVisible("Show grouped");
    if (!SL_PAUSED) {
      await m.scrollUntilVisible(".*Save [0-9]+ sets.*", { timeout: 7_000 });
      await m.tapOn(".*Save [0-9]+ sets.*");
      await m.waitNotVisible("Reconcile Inserts", 7_000);
    }
    await utilDrillTo2024ToppsChrome(m, { SPORT: "Baseball", YEAR: "2026", MANUFACTURER: "Bowman", SET: "Bowman" });
    await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Insert");
    await m.waitVisible(".*Search inserts.*", 7_000);
    await m.scrollUntilVisible(".*Search inserts.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search inserts.*");
    await m.inputText("Anime");
    await m.waitVisible(m.below("^Anime$", m.id("Search inserts")), 7_000);
    await m.assertNotVisible(m.below("^Anime Kanji$", m.id("Search inserts")));
    await m.tapOn(m.below("^Anime$", m.id("Search inserts")));
    await m.waitVisible("Parallels", 7_000);
    await m.waitVisible("^Anime Kanji$", 7_000);
    await m.scrollUntilVisible(m.id("Sync card checklist"), { centerElement: true, direction: "DOWN", timeout: 7_000 });
    await m.assertVisible("No cards in this checklist yet.");
    await m.tapOn(m.id("Sync card checklist"));
    await m.waitVisible("Match Cards.*|.*Kept all [0-9]+ cards? from BSC.*", 120_000);
    if (SL_PAUSED) {
      await m.assertNotVisible("Match Cards.*");
    }
    if (await m.isVisible("Match Cards.*")) {
      await m.waitVisible("^Confirm$", 120_000);
      await m.assertVisible(".*Match Cards — Anime");
      await m.tapOn(m.id("Confirm card matches"));
      await m.waitNotVisible("Match Cards.*", 7_000);
    }
    await m.waitVisible("Confirm New Players & Teams|.*Saved [0-9]+ cards.*", 60_000);
    if (await m.isVisible("Confirm New Players & Teams")) {
      await m.retry(1, async () => {
        await m.tapOn(".*Skip remaining names \\([0-9]+\\).*");
        await m.waitVisible(".*Confirm & Save.*", 60_000);
      });
      await m.tapOn(".*Confirm & Save.*");
    }
    await m.waitVisible(".*Saved [1-9][0-9]* cards?.*", 7_000);
    await m.scrollUntilVisible("Building parallels of Anime — [0-9]+ of [0-9]+|Anime parallels — [^.]+", { centerElement: true, direction: "DOWN", timeout: 7_000 });
    await m.waitVisible("Anime parallels — [1-9][0-9]* built(, [0-9]+ (blocked|skipped|failed))*", 60_000);
    await m.assertVisible("Anime Kanji — Built [1-9][0-9]* cards?(, .+)?");
    await m.scrollUntilVisible("^Anime Kanji$", { centerElement: true, direction: "UP", timeout: 7_000 });
    await m.tapOn("^Anime Kanji$");
    await m.scrollUntilVisible("Multi-source sets", { centerElement: true, direction: "DOWN", timeout: 7_000 });
    await m.waitVisible(m.id("Remove Anime Kanji"), 7_000);
    await m.assertVisible(m.id("Anime Kanji is attached as a BSC variant"));
    await m.assertNotVisible("Needs re-mapping");
    await m.scrollUntilVisible(m.id("Remove Anime Kanji"), { centerElement: true, direction: "DOWN", timeout: 7_000 });
    await m.tapOn(m.id("Remove Anime Kanji"));
    await m.waitVisible(".*(1 card was|[1-9][0-9]* cards were) fetched from it; (its|their) BSC link will be dropped.*", 7_000);
    await m.tapOn(m.id("Cancel detach Anime Kanji"));
    await m.waitNotVisible(".*fetched from it.*", 7_000);
    await m.assertVisible(m.id("Remove Anime Kanji"));
    await m.scrollUntilVisible("Rebuild from Anime", { direction: "DOWN", timeout: 7_000 });
  },
);
