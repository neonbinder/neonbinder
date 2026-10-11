// Port of .maestro/flows/set-selector/keyboard-only-drill.yaml
import { test } from "../../support/fixtures";
import { idWithText } from "../../support/value-selectors";

test(
  "Set Builder drill is keyboard-only — type to filter, Enter picks the first match, focus follows into the next column and lands on the attributes toggle after Base (NEO-224)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await m.waitVisible(m.id("Search sports"), 7_000);

    // ── SPORT
    await m.inputText("Baseball");
    await m.waitVisible(idWithText(m, "Search sports", "Baseball"), 7_000);
    await m.waitVisible(m.below("Baseball", m.id("Search sports")), 7_000);
    await m.pressKey("Enter");
    await m.waitVisible(m.id("Sports: Baseball — change"), 7_000);
    await m.waitVisible("Years", 7_000);

    // ── YEAR
    await m.inputText("2024");
    await m.waitVisible(idWithText(m, "Search years", "2024"), 7_000);
    await m.waitVisible(m.below("2024", m.id("Search years")), 7_000);
    await m.pressKey("Enter");
    await m.waitVisible(m.id("Years: 2024 — change"), 7_000);
    await m.waitVisible("Manufacturers", 7_000);

    // ── MANUFACTURER
    await m.inputText("Topps");
    await m.waitVisible(idWithText(m, "Search manufacturers", "Topps"), 7_000);
    await m.waitVisible(m.below("Topps", m.id("Search manufacturers")), 7_000);
    await m.pressKey("Enter");
    await m.waitVisible(m.id("Manufacturers: Topps — change"), 7_000);
    await m.waitVisible("Sets", 7_000);

    // ── SET
    await m.inputText("Topps Chrome");
    await m.waitVisible(idWithText(m, "Search sets", "Topps Chrome"), 7_000);
    await m.waitVisible(m.below("Topps Chrome", m.id("Search sets")), 7_000);
    await m.pressKey("Enter");
    await m.waitVisible("Variant Types", 7_000);
    await m.waitVisible(m.id("Sets: Topps Chrome — change"), 7_000);

    // ── VARIANT TYPE (terminal)
    await m.inputText("Base");
    await m.waitVisible(idWithText(m, "Search variant types", "Base"), 7_000);
    await m.waitVisible(m.below("Base", m.id("Search variant types")), 7_000);
    await m.pressKey("Enter");
    await m.scrollUntilVisible(m.id("Variant Types: Base — change"), { direction: "UP", timeout: 7_000 });

    // ── D3: focus landed on the attributes toggle
    if (!env.SL_PAUSED) {
      await m.scrollUntilVisible("Re-map Base", { direction: "DOWN", timeout: 7_000 });
      await m.scrollUntilVisible(m.id("Edit attributes"), { direction: "DOWN", timeout: 7_000 });
      // Both buttons share the accessible name "Sync card checklist"; the
      // visible word tells them apart.
      await m.scrollUntilVisible(
        m.id("Sync card checklist").filter({ hasText: /^\s*Refresh\s*$/i }),
        { direction: "DOWN", timeout: 7_000 },
      );
      await m.pressKey("Enter");
      await m.scrollUntilVisible(m.id("Hide attributes"), { direction: "UP", timeout: 7_000 });
    } else {
      await m.waitVisible("Select Base Set", 7_000);
    }
  },
);
