// Port of .maestro/flows/set-selector/checklist-wizard-link-team-saves-alias.yaml
//
// PORT-GAP (swipes): the two `swipe ... duration:` steps in PART 4 are touch
// drags that scroll the review wizard's own body. The driver's swipe() scrolls
// the WINDOW and takes no duration, so they are ported (same coordinates) but
// do not move the wizard body; Playwright scrolls a target into view before
// clicking it, so the taps still land.
import { expect, test } from "../../support/fixtures";
import { pickNativeOption } from "../../support/subflows/native-select";
import { idWithText, valueOrText } from "../../support/value-selectors";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";

/** Maestro treats `${output.ROW_NAME}` as a regex; escape it so a name with metacharacters still matches itself. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test(
  "Entity review — linking a checklist TEAM to an existing team remembers the checklist's spelling as one of that team's names",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const TOKEN = env.ATTEMPT_TOKEN;
    const FIX = `Loc${TOKEN} Ali${TOKEN}`;

    await m.launch(m.signInUrl("/admin/players"));
    await m.waitVisible(".*of .* players.*", 45_000);

    // ── PART 1 — the fixture team, born from a career editor
    await m.tapOn("Filter players");
    await m.inputText("zzzznotaplayer");
    await m.assertVisible("No players match that filter.");
    await pickNativeOption(m, "Baseball"); // tapOn "All sports" + tapOn "Baseball"
    await m.assertVisible("Baseball");
    await m.waitVisible("0 matches", 7_000);

    await m.tapOn("Add player");
    await m.tapOn("New player name");
    await m.inputText(`Alp${TOKEN}`);
    await m.scrollUntilVisible(m.id(`Create player Alp${TOKEN}`), { timeout: 7_000 });
    await m.tapOn(m.id(`Create player Alp${TOKEN}`));

    await m.waitVisible(m.above(`Alp${TOKEN}`, "Player name"), 7_000);
    await m.assertVisible(`.*Added Alp${TOKEN}.*`);
    await m.scrollUntilVisible("No stints recorded yet.", { centerElement: true, timeout: 7_000 });

    await m.assertVisible(m.id("Add team"));
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`Ali${TOKEN}`);
    await m.assertVisible("No matches.");
    await m.pressKey("Enter");
    await m.assertVisible(`New team: Ali${TOKEN}`);
    await m.tapOn(m.id("New team location \\(optional\\)"));
    await m.inputText(`Loc${TOKEN}`);
    await m.tapOn(m.id(`Create team ${FIX}`));
    await m.waitVisible(m.id(`Remove team ${FIX}`), 7_000);

    // R2(h): the retro club, with a closed era, through the same picker
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText("Pittsburgh Crawfords");
    await m.assertVisible("No matches.");
    await m.pressKey("Enter");
    await m.assertVisible("New team: Pittsburgh Crawfords");
    await m.tapOn(m.id("New team active from \\(optional\\)"));
    await m.inputText("1926");
    await m.tapOn(m.id("New team active to"));
    await m.inputText("1940");
    await m.tapOn(m.id("New team aliases \\(optional\\)"));
    await m.inputText(`Pca${TOKEN}`);
    await m.tapOn(m.id("Create team Pittsburgh Crawfords"));
    await m.waitVisible(m.id("Remove team Pittsburgh Crawfords"), 7_000);

    // ── PART 2 — the set: drill, decline SportLots, fetch one-sided
    await utilDrillTo2024ToppsChrome(m, { SET: "Topps MLB at Rickwood Field Negro Leagues Collection" });
    await m.scrollUntilVisible("Base", { centerElement: true, timeout: 7_000 });
    await m.retry(1, async () => {
      await m.tapOn("Base");
      await m.waitVisible("Select Base Set", 7_000);
    });

    await m.waitVisible("Confirm Base Set", 60_000);
    await m.assertVisible(m.id("BSC base candidate: .*"));
    if (!env.SL_PAUSED) {
      await m.assertVisible(m.id("SportLots base candidate: .*"));
    } else {
      await m.assertVisible("SportLots returned no base set for .*");
      await m.assertNotVisible(m.id("SportLots base candidate: .*"));
    }
    await m.tapOn("Cancel");
    await m.assertVisible(".*Base mapping cancelled.*");
    await m.scrollUntilVisible("Close", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Close");
    await m.waitNotVisible(".*Base mapping cancelled.*", 7_000);
    await m.assertVisible("Map Base Set");

    await m.scrollUntilVisible("Add Card", { centerElement: true, timeout: 7_000 });
    await m.assertVisible("No cards in this checklist yet.");
    await m.scrollUntilVisible(m.id("Sync card checklist"), { timeout: 7_000 });
    await m.tapOn(m.id("Sync card checklist"));

    await m.waitVisible(".*Kept all [0-9]+ cards? from .*", 60_000);
    await m.waitVisible("Confirm New Players & Teams", 60_000);

    // ── PART 3 — the team row
    await m.assertVisible("0 of [0-9]+ reviewed.*");
    await m.waitNotVisible(".*still looking up.*", 180_000);

    for (let i = 0; i < 20; i++) {
      if (!(await m.isNotVisible(m.id("Skip .* not a team")))) break;
      if (await m.isVisible(m.id("Skip .* has no league"))) {
        await m.tapOn(m.id("Skip .* has no league"), { optional: true });
      }
    }
    await m.waitVisible(m.id("Skip .* not a team"), 7_000);

    const heading = await m.copyTextFrom("New Team: .*");
    const ROW_NAME = heading.replace(/^New Team: /, "");
    const ROW = esc(ROW_NAME);
    expect(ROW_NAME.length).toBeGreaterThan(0);
    expect(ROW_NAME).not.toBe("Pittsburgh Crawfords");

    // ── PART 4 — link, with the remember-box on
    await m.waitVisible(idWithText(m, "Search all teams", "Type a team name"), 7_000);
    await m.assertVisible(m.above("Link to existing team", m.id("Search all teams")));
    await m.assertVisible(
      m.below(`Remember “${ROW}” as a name for this team`, m.id("Search all teams")),
    );

    // R2(i): a New Team name that is another team's ALIAS is refused
    await m.swipe({ start: "18%, 70%", end: "18%, 20%" });
    await m.tapOn(valueOrText(m, ROW, { below: "Team name" }));
    await m.eraseText(60);
    await m.inputText(`Pca${TOKEN}`);
    await m.waitVisible(
      "Pittsburgh Crawfords already answers to this name as an alias . remove it there before a team can take the name\\.",
      7_000,
    );
    await m.assertVisible("Link to Pittsburgh Crawfords . 1926.1940");
    const COUNT_BEFORE = await m.copyTextFrom("[0-9]+ of [0-9]+ reviewed.*");
    await m.tapOn(m.id("Add as New Team"));

    await m.swipe({ start: "18%, 20%", end: "18%, 95%" });
    await m.assertVisible(`New Team: ${ROW}`);

    await m.tapOn(m.id("Search all teams"));
    await m.inputText(`Ali${TOKEN}`);
    await m.waitVisible(idWithText(m, "Search all teams", `Ali${TOKEN}`), 7_000);
    expect(await m.copyTextFrom("[0-9]+ of [0-9]+ reviewed.*")).toBe(COUNT_BEFORE);
    await m.waitVisible(FIX, 7_000);
    await m.tapOn(FIX);
    await m.waitNotVisible(`New Team: ${ROW}`, 7_000);

    await m.tapOn(m.id("Back to previous decision"));
    await m.waitVisible(m.id(`Decision for ${ROW}`), 7_000);
    await m.assertVisible(`Linked to ${FIX} · remembered as “${ROW}”`);
    await m.tapOn(m.below("Next", "Already decided:.*"));

    // ── PART 5 — commit, after reading every other team step
    for (let i = 0; i < 20; i++) {
      if (!(await m.isNotVisible(m.id("Skip .* not a person")))) break;
      if (await m.isVisible(m.id("Skip .*(not a team|has no league)"))) {
        const stepHeading = await m.copyTextFrom("New (Team|League): .*");
        const skipText = await m.copyTextFrom(m.id("Skip .*(not a team|has no league)"));
        const ok = skipText.indexOf("no league") >= 0
          ? stepHeading.indexOf("New League: ") === 0
          : stepHeading.indexOf("New Team: ") === 0 && stepHeading !== "New Team: Pittsburgh Crawfords";
        expect(ok).toBe(true);
        await m.tapOn(m.id("Skip .*(not a team|has no league)"), { optional: true });
      }
    }
    await m.waitVisible(m.id("Skip .* not a person"), 7_000);

    await m.tapOn(".*Skip remaining names \\([0-9]+\\).*");
    await m.waitVisible(".*Confirm & Save.*", 7_000);
    await m.tapOn(".*Confirm & Save.*");
    await m.waitVisible(".*Saved [0-9]+ cards.*", 7_000);

    await m.scrollUntilVisible(".*Pittsburgh Crawfords(?! \\(unconfirmed\\)).*", {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });

    // ── PART 6 — Team Management shows the alias
    await m.openLink("/admin/teams");
    await m.waitVisible(".*of .* teams.*", 30_000);
    await m.tapOn("Filter teams");
    await m.inputText(`Ali${TOKEN}`);
    await m.waitVisible("1 of .* teams.*", 7_000);
    await m.tapOn(valueOrText(m, `Ali${TOKEN}`, { below: "1 of .* teams.*" }));

    await m.scrollUntilVisible("Also known as", { centerElement: true, timeout: 7_000 });
    await m.assertVisible(m.id("Current aliases"));
    await m.assertVisible(valueOrText(m, ROW, { below: "Also known as" }));

    // ── PART 7 — take it back out, and prove the removal persisted
    await m.tapOn(valueOrText(m, ROW, { below: "Also known as" }));
    await m.eraseText(120);
    await m.assertNotVisible(m.id("Current aliases"));
    await m.scrollUntilVisible("Save", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Save");
    await m.waitVisible(`.*Saved ${FIX}.*`, 7_000);

    await m.openLink("/admin/teams");
    await m.waitVisible(".*of .* teams.*", 30_000);
    await m.tapOn("Filter teams");
    await m.inputText(`Ali${TOKEN}`);
    await m.waitVisible("1 of .* teams.*", 7_000);
    await m.tapOn(valueOrText(m, `Ali${TOKEN}`, { below: "1 of .* teams.*" }));
    await m.scrollUntilVisible("Also known as", { centerElement: true, timeout: 7_000 });
    await m.assertNotVisible(m.id("Current aliases"));
    await m.assertVisible(valueOrText(m, "LSU, Louisiana State, LSU Tigers baseball", { below: "Also known as" }));

    // ── PART 8 — the retro club is still one row
    await m.openLink("/admin/teams");
    await m.waitVisible(".*of .* teams.*", 30_000);
    await m.tapOn("Filter teams");
    await m.inputText("Pittsburgh Crawfords");
    await m.waitVisible("1 of .* teams.*", 7_000);
  },
);
