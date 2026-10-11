// Port of .maestro/flows/admin/player-live-wikidata-enrichment.yaml
import { test } from "../../support/fixtures";
import { pickNativeOption } from "../../support/subflows/native-select";

test(
  "Player Management — a player added by hand is enriched from LIVE Wikidata (the lane the seed no longer exercises)",
  { tag: ["@admin", "@players"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/admin/players"));
    await m.waitVisible(".*of .* players.*", 45_000);

    await m.tapOn("Filter players");
    await m.inputText("zzzznotaplayer");
    await m.assertVisible("No players match that filter.");
    await m.assertVisible("0 matches");

    await pickNativeOption(m, "Baseball"); // tapOn "All sports" + tapOn "Baseball"
    await m.assertVisible("Baseball");
    await m.waitVisible("0 matches", 7_000);
    await m.scrollUntilVisible("Add player", { centerElement: true, timeout: 7_000 });
    await m.retry(1, async () => {
      await m.tapOn("Add player");
      await m.waitVisible("Add a player", 7_000);
    });

    await m.tapOn("New player name");
    await m.inputText("Harmon Killebrew");
    await m.scrollUntilVisible(m.id("Create player Harmon Killebrew"), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id("Create player Harmon Killebrew"));

    await m.waitVisible(m.above("Harmon Killebrew", "Player name"), 7_000);
    await m.assertVisible(".*Added Harmon Killebrew.*");
    await m.assertVisible(".*Sport: Baseball.*");

    // Live Wikidata round trip: the flow's own 10-minute wait.
    await m.waitVisible("Wikidata Q[0-9]+", 600_000);
  },
);
