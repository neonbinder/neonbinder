// Port of .maestro/flows/spine-label/player-team-colors-default-to-longest-tenure.yaml
import { test, expect } from "../../support/fixtures";

test(
  "Spine Labels — a player's colours default to their longest-tenure team",
  { tag: ["@spine-label"] },
  async ({ m, env }) => {
    const T = env.ATTEMPT_TOKEN;
    await m.launch(m.signInUrl("/admin/players"));

    // Wait for the COUNTER, not the heading: the filter swallows keystrokes while the list loads.
    await m.waitVisible(".*of .* players.*", 45_000);

    await m.tapOn("Filter players");
    await m.inputText("zzzznotaplayer");
    await m.assertVisible("No players match that filter.");

    await m.tapOn("All sports");
    await m.tapOn("Baseball");

    await m.tapOn("Add player");
    await m.assertVisible("Add a player");
    await m.tapOn("New player name");
    await m.inputText(`SLP${T}`);
    await m.scrollUntilVisible(m.id(`Create player SLP${T}`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Create player SLP${T}`));

    await m.waitVisible(m.above(`SLP${T}`, "Player name"), 7_000);
    await m.assertVisible(`.*Added SLP${T}.*`);

    // ── Team A: 2000-2010 (the long stint) ──
    await m.scrollUntilVisible(m.id("Add team"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`SLA${T}`);
    await m.assertVisible("No matches.");
    await m.pressKey("Enter");
    await m.assertVisible(`New team: SLA${T}`);
    await expect(await m.resolve(m.id("New team name"))).toHaveValue(`SLA${T}`, { timeout: 7_000 });
    await m.tapOn(m.id(`Create team SLA${T}`));
    await m.waitVisible(m.id(`Remove team SLA${T}`), 7_000);

    await m.tapOn("Career history");
    await m.tapOn(".*Stint from year.*");
    await m.inputText("2000");
    await m.tapOn(".*Stint to year.*");
    await m.inputText("2010");
    await m.tapOn("Add stint");
    await m.scrollUntilVisible(`.*SLA${T} · 2000–2010.*`, { centerElement: true, timeout: 7_000 });

    // ── Team B: 2012-2014 (the short stint) ──
    await m.scrollUntilVisible(m.id("Add team"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add team"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`SLB${T}`);
    await m.assertVisible("No matches.");
    await m.pressKey("Enter");
    await m.assertVisible(`New team: SLB${T}`);
    await expect(await m.resolve(m.id("New team name"))).toHaveValue(`SLB${T}`, { timeout: 7_000 });
    await m.tapOn(m.id(`Create team SLB${T}`));
    await m.waitVisible(m.id(`Remove team SLB${T}`), 7_000);
    await m.tapOn("Career history");
    await m.tapOn(".*Stint from year.*");
    await m.inputText("2012");
    await m.tapOn(".*Stint to year.*");
    await m.inputText("2014");
    await m.tapOn("Add stint");
    await m.scrollUntilVisible(`.*SLB${T} · 2012–2014.*`, { centerElement: true, timeout: 7_000 });

    await m.scrollUntilVisible("Save", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Save");
    await m.waitVisible(`.*Saved SLP${T}.*`, 15_000);

    // ── Give each team its colour (Team Management) ──
    await m.openLink("/admin/teams");
    await m.waitVisible(".*of .* teams.*", 30_000);
    await m.inputText(`SLA${T}`);
    await m.waitVisible("1 of .* teams.*", 15_000);
    await m.tapOn(m.below(`SLA${T}`, "1 of .* teams.*"));
    await m.scrollUntilVisible("#01214b", { centerElement: true, timeout: 7_000 });
    await m.tapOn("#01214b");
    await m.inputText("#132448");
    await m.scrollUntilVisible("Save", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Save");
    await m.waitVisible(`.*Saved SLA${T}.*`, 15_000);

    await m.openLink("/admin/teams");
    await m.waitVisible(".*of .* teams.*", 30_000);
    await m.inputText(`SLB${T}`);
    await m.waitVisible("1 of .* teams.*", 15_000);
    await m.tapOn(m.below(`SLB${T}`, "1 of .* teams.*"));
    await m.scrollUntilVisible("#01214b", { centerElement: true, timeout: 7_000 });
    await m.tapOn("#01214b");
    await m.inputText("#002d72");
    await m.scrollUntilVisible("Save", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Save");
    await m.waitVisible(`.*Saved SLB${T}.*`, 15_000);

    // ── The feature: the spine designer defaults to the longest-tenure team's colour ──
    await m.openLink("/print/spine-label");
    await m.waitVisible("Spine Labels", 30_000);

    await m.scrollUntilVisible("Find a player", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Find a player");
    await m.inputText("SLP");
    await m.waitVisible(`SLP${T}`, 15_000);
    await m.tapOn(`SLP${T}`);

    await m.waitVisible(`.*Defaults to the team SLP${T} spent longest with.*`, 15_000);

    await m.scrollUntilVisible(`.*SLA${T}.*`, { centerElement: true, timeout: 7_000 });
    await m.assertVisible(`.*SLB${T}.*`);

    await m.assertNotVisible("Find a team");

    await m.scrollUntilVisible("Background", { centerElement: true, timeout: 7_000 });
    await m.assertVisible("#132448");
    await m.assertNotVisible("#002d72");

    await m.tapOn(`.*SLB${T}.*`);
    await m.waitVisible("#002d72", 10_000);
  },
);
