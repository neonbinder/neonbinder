// Port of .maestro/flows/admin/admin-players-same-name-birth-year.yaml
import { test } from "../../support/fixtures";
import { pickNativeOption } from "../../support/subflows/native-select";
import type { Maestro } from "../../support/maestro";

/** The flow's `retry: maxRetries: 1` around opening the add form. */
async function openAddForm(m: Maestro): Promise<void> {
  await m.scrollUntilVisible("Add player", { centerElement: true, timeout: 7_000 });
  await m.retry(1, async () => {
    await m.tapOn("Add player");
    await m.waitVisible("Add a player", 7_000);
  });
}

test(
  "Player Management — a birth year is bounded, shows on the row, and is what lets a repeated name become a genuinely second player",
  { tag: ["@admin"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/admin/players"));
    await m.waitVisible(".*of .* players.*", 45_000);

    const TOKEN = env.ATTEMPT_TOKEN;
    const NAME = `Samename${TOKEN}`;

    await m.tapOn("Filter players");
    await m.inputText("zzzznotaplayer");
    await m.assertVisible("No players match that filter.");
    await m.assertVisible("0 matches");
    await pickNativeOption(m, "Baseball"); // tapOn "All sports" + tapOn "Baseball"
    await m.assertVisible("Baseball");

    // ── (1) an out-of-range birth year is refused ──
    await openAddForm(m);
    await m.tapOn("New player name");
    await m.inputText(NAME);
    await m.tapOn("Birth year \\(optional\\)");
    await m.inputText("1700");
    await m.scrollUntilVisible("Use a whole year between 1850 and 2[0-9]{3}\\.", { timeout: 7_000 });
    await m.scrollUntilVisible(m.id(`Create player ${NAME}`), { timeout: 7_000 });
    await m.tapOn(m.id(`Create player ${NAME}`));
    await m.scrollUntilVisible("Add a player", { direction: "UP", timeout: 7_000 });
    await m.assertVisible(NAME);
    await m.scrollUntilVisible("Filter players", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.assertNotVisible(`.*Added ${NAME}.*`);

    // ── (2) a valid year creates the player ──
    await m.tapOn("Birth year \\(optional\\)");
    await m.eraseText(6);
    await m.inputText("1960");
    await m.scrollUntilVisible("Tells this player apart from anyone else with the same name.", {
      timeout: 7_000,
    });
    await m.scrollUntilVisible(m.id(`Create player ${NAME}`), { timeout: 7_000 });
    await m.tapOn(m.id(`Create player ${NAME}`));
    await m.scrollUntilVisible("Filter players", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.waitVisible(`.*Added ${NAME}.*`, 7_000);

    await m.tapOn("Filter players");
    await m.eraseText(20);
    await m.inputText(NAME);
    await m.waitVisible("1 matches", 7_000);
    await m.assertVisible(m.below(".*b. 1960.*", "1 matches"));

    // ── (3) the same name, no year: the existing row is opened, not duplicated ──
    await openAddForm(m);
    await m.tapOn("New player name");
    await m.inputText(NAME);
    await m.scrollUntilVisible(m.id(`Create player ${NAME} anyway`), { timeout: 7_000 });
    await m.tapOn(m.id(`Create player ${NAME} anyway`));
    await m.scrollUntilVisible("Filter players", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.waitVisible("That player already exists — opened it.", 7_000);
    await m.assertVisible("1 matches");
    await m.assertVisible(m.below(".*b. 1960.*", "1 matches"));

    // ── (4) the same name with a different year: a genuinely second player ──
    await openAddForm(m);
    await m.tapOn("New player name");
    await m.inputText(NAME);
    await m.tapOn("Birth year \\(optional\\)");
    await m.inputText("1975");
    await m.scrollUntilVisible(m.id(`Create player ${NAME} anyway`), { timeout: 7_000 });
    await m.tapOn(m.id(`Create player ${NAME} anyway`));
    await m.scrollUntilVisible("Filter players", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.waitVisible(`.*Added ${NAME}.*`, 7_000);
    await m.waitVisible("2 matches", 7_000);
    await m.assertVisible(m.below(".*b. 1960.*", "2 matches"));
    await m.assertVisible(m.below(".*b. 1975.*", "2 matches"));
  },
);
