// Port of .maestro/flows/admin/player-add-spaced-initials-opens-roster-row.yaml
import { test } from "../../support/fixtures";
import { pickNativeOption } from "../../support/subflows/native-select";

test(
  "Player Management — typing spaced initials finds the roster player written without the spaces",
  { tag: ["@admin"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/admin/players"));
    await m.waitVisible(".*of .* players.*", 45_000);

    // STEP 1 — the roster row exists, spelled without spaces between initials.
    await m.tapOn("Filter players");
    await m.inputText("Realmuto");
    await m.waitVisible("J\\.?T\\.? Realmuto", 7_000);

    // STEP 2 — empty the list, pick Baseball, open the add form.
    await m.tapOn("Filter players");
    await m.inputText("zzzz");
    await m.waitVisible("No players match that filter.", 7_000);
    await m.waitVisible("0 matches", 7_000);

    await pickNativeOption(m, "Baseball"); // tapOn "All sports" + tapOn "Baseball"
    await m.assertVisible("Baseball");
    await m.waitVisible("0 matches", 7_000);
    await m.scrollUntilVisible("Add player", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Add player");
    await m.waitVisible("Add a player", 7_000);

    await m.tapOn("New player name");
    await m.inputText("J. T. Realmuto");

    // STEP 3 — the form recognises the roster player.
    await m.scrollUntilVisible(m.id("Create player J\\. T\\. Realmuto anyway"), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.waitVisible("Open J\\.?T\\.? Realmuto", 7_000);
    await m.assertNotVisible(m.id("Create player J\\. T\\. Realmuto"));

    // STEP 4 — Open lands on the existing roster row.
    await m.tapOn("Open J\\.?T\\.? Realmuto");
    await m.waitVisible(m.above("J\\.?T\\.? Realmuto", "Player name"), 7_000);
    await m.assertVisible(".*Sport: Baseball.*");
  },
);
