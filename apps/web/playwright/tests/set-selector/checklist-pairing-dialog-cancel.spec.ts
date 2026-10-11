// Port of .maestro/flows/set-selector/checklist-pairing-dialog-cancel.yaml
import { test, expect } from "../../support/fixtures";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

test(
  "Checklist — the card-pairing dialog opens instead of committing, flags a marketplace name disagreement on a manual link, and cancelling writes nothing",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    const SL_PAUSED = utilPausedPlatforms(m);
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilDrillTo2024ToppsChrome(m);
    await m.scrollUntilVisible("Insert", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Insert");
    await m.waitVisible("Inserts", 20_000);
    await m.waitVisible(".*Search inserts.*", 60_000);
    await m.scrollUntilVisible(".*Search inserts.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Search inserts.*");
    await m.inputText("Future Stars");
    await m.waitVisible(m.below("^Future Stars$", m.id("Search inserts")), 15_000);
    await m.tapOn(m.below("^Future Stars$", m.id("Search inserts")));
    await m.scrollUntilVisible(m.id("Sync card checklist"), { centerElement: true, timeout: 7_000 });
    if (!SL_PAUSED) {
      await m.tapOn(m.id("Sync card checklist"));
      await m.waitVisible("Match Cards.*", 90_000);
      await m.assertVisible(".*Match Cards — Future Stars.*");
      await m.assertVisible(".*Unlink.*");
      await m.assertVisible(".*[0-9]+ cards? will be saved.*");
      await m.waitVisible("^Confirm$", 90_000);
      await m.assertVisible(".*Matched [(]20[)].*");
      await m.tapOn(m.id("Unlink #FS-1 .*"));
      await m.waitVisible(".*Matched [(]19[)].*", 7_000);
      await m.tapOn(m.id("Unlink #FS-2 .*"));
      await m.waitVisible(".*Matched [(]18[)].*", 7_000);
      await m.tapOn(m.id("Collapse matched cards.*"));
      await m.waitVisible(m.id("Expand matched cards.*"), 7_000);
      await m.assertVisible(".*BSC only [(]2[)].*");
      await m.tapOn(m.id("Select BSC card #FS-1 .*"));
      await m.waitVisible(m.id("#FS-1 .*, selected. Press to deselect."), 7_000);
      await m.tapOn(m.id("Link selected BSC card to #FS-2 .*"));
      await m.waitVisible(m.id("Collapse matched cards, .* with a name conflict"), 7_000);
      await m.assertVisible(".*name conflict.*");
      await m.assertVisible(m.id("Name conflict on #FS-1"));
      await m.assertVisible(".*These marketplaces name this card differently.*");
      await m.assertVisible(m.id("Name for #FS-1"));
      await m.assertVisible(m.id("BSC: .* — use this name for #FS-1"));
      await m.assertVisible(m.id("SportLots: .* — use this name for #FS-1"));
      const bscCopied = await m.copyTextFrom(m.id("BSC: .* — use this name for #FS-1"));
      const bscName = bscCopied.replace("BSC: ", "").trim();
      const slCopied = await m.copyTextFrom(m.id("SportLots: .* — use this name for #FS-1"));
      const slName = slCopied.replace("SportLots: ", "").trim();
      expect(slName !== bscName).toBe(true);
      await m.assertVisible(m.id(`Unlink #FS-1 ${bscName}`));
      await m.tapOn(m.id("SportLots: .* — use this name for #FS-1"));
      await m.waitVisible(m.id(`Unlink #FS-1 ${slName}`), 7_000);
      await m.assertNotVisible(m.id(`Unlink #FS-1 ${bscName}`));
      await m.tapOn(m.id("Edit name for #FS-1 .*"));
      await m.waitVisible(m.id("Edit name for #FS-1"), 7_000);
      await m.eraseText(60);
      await m.inputText("NB Operator Name");
      await m.pressKey("Enter");
      await m.waitVisible(m.id("Custom: NB Operator Name.* — use this name for #FS-1"), 7_000);
      await m.assertVisible(m.id("Unlink #FS-1 NB Operator Name.*"));
      await m.assertNotVisible(m.id(`Unlink #FS-1 ${slName}`));
      await m.assertVisible(m.id("BSC: .* — use this name for #FS-1"));
      await m.assertVisible(m.id("SportLots: .* — use this name for #FS-1"));
      await m.assertVisible(".*19 cards will be saved.*");
      await m.assertVisible("^Confirm$");
      await m.tapOn(m.id("Cancel card matching"));
      await m.tapOn(m.below("Discard .*", ".*No cards have been saved.*"));
      await m.waitNotVisible("Match Cards.*", 10_000);
      await m.assertVisible("Sync cancelled — no cards saved.");
      await m.assertNotVisible("Confirm New Players & Teams");
      await m.scrollUntilVisible(m.id("Sync card checklist"), { centerElement: true, direction: "UP", timeout: 7_000 });
    }
    if (SL_PAUSED) {
      await m.scrollUntilVisible(".*#FS-[0-9].*", { centerElement: true, timeout: 7_000 });
      await m.assertVisible("BSC");
      await m.assertVisible("BSC only");
      await m.assertNotVisible("SL");
      await m.scrollUntilVisible("SportLots is on pause\\.", { direction: "UP", timeout: 7_000 });
      await m.assertVisible(".*Syncs roll on with BuySportsCards only\\. Your SportLots links stay put — nothing gets unlinked\\..*");
      await m.assertNotVisible("Match Cards.*");
      await m.assertNotVisible("Sync cancelled — no cards saved.");
    }
  },
);
