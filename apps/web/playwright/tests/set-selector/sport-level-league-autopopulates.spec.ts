// Port of .maestro/flows/set-selector/sport-level-league-autopopulates.yaml
import { test } from "../../support/fixtures";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

test(
  "Write-once feature snapshots — the SPORT-level attributes panel auto-populates League from the sport, with NO card-checklist step",
  { tag: ["@set-selector"] },
  async ({ m, page }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustom(m, { SPORT: "Baseball" });

    await m.assertVisible("Years");

    await m.scrollUntilVisible(".*Attributes for Baseball.*Sport.*", { centerElement: true, timeout: 7_000 });

    if (await m.isVisible(m.id("Edit attributes"))) {
      await m.tapOn(m.id("Edit attributes"));
      await m.assertVisible(m.id("Hide attributes"));
    }
    await m.assertVisible(m.id("Hide attributes"));

    // Maestro's combined { id: "Value for League", text: "MLB" }: the League
    // <select> whose SELECTED option reads MLB.
    await m.scrollUntilVisible(
      m.id("Value for League").filter({ has: page.getByRole("option", { name: "MLB", selected: true }) }),
      { centerElement: true, timeout: 7_000 },
    );
  },
);
