// Port of .maestro/flows/admin/league-management-add-and-edit.yaml
import { test, expect } from "../../support/fixtures";
import { mrx } from "../../support/maestro";
import { pickNativeOption } from "../../support/subflows/native-select";
import { valueOrText } from "../../support/value-selectors";

test(
  "League Management — add a league by hand, classify it, and edit what we know about it",
  { tag: ["@admin"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/admin/leagues"));
    await m.waitVisible(".*of .* leagues.*", 45_000);

    const LEAGUE = `LG-${env.WORKER_INDEX}-${env.ATTEMPT_ID}`;
    const ABBR = `L${env.ATTEMPT_ID}`;
    const ALIAS_A = `Alias-${env.ATTEMPT_ID}`;
    const ALIAS_B = `Second-${env.ATTEMPT_ID}`;

    await m.tapOn("Filter leagues");
    await m.inputText("zzzznotaleague");
    await m.assertVisible("No leagues match that filter.");
    await m.assertVisible("0 of .* leagues.*");

    await pickNativeOption(m, "Baseball"); // tapOn "All sports" + tapOn "Baseball"
    await m.assertVisible("Baseball");

    await m.scrollUntilVisible("Add league", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Add league");
    await m.waitVisible("Add a league", 7_000);

    await m.tapOn("New league name");
    await m.inputText(LEAGUE);
    await m.tapOn("Abbreviation");
    await m.inputText(ABBR);
    await m.scrollUntilVisible("Minor", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Minor");
    await m.scrollUntilVisible(m.id(`Create league ${LEAGUE}`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Create league ${LEAGUE}`));

    await m.scrollUntilVisible(`.*Added ${LEAGUE}.*`, { direction: "UP", timeout: 7_000 });
    await m.scrollUntilVisible(".*Sport: Baseball.*", { centerElement: true, timeout: 7_000 });

    // ── Edit: Active from + Aliases ──
    await m.scrollUntilVisible("Active from", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Active from");
    await m.inputText("1901");
    await m.scrollUntilVisible("Aliases", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Aliases");
    await m.inputText(`${ALIAS_A}, ${ALIAS_B}`);
    await m.scrollUntilVisible("Save", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Save");
    await m.waitVisible(`.*Saved ${LEAGUE}.*`, 7_000);

    // ── Reload: what we saved is what we read back ──
    await m.openLink("/admin/leagues");
    await m.waitVisible(".*of .* leagues.*", 30_000);
    await m.tapOn("Filter leagues");
    await m.inputText(LEAGUE);
    await m.assertVisible("1 of .* leagues.*");
    await m.assertVisible("Select a league to see its teams and edit what we know about it.");
    await m.assertVisible("Minor");
    await m.assertVisible(ABBR);
    await m.scrollUntilVisible(m.id(LEAGUE), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(LEAGUE));

    await m.scrollUntilVisible(valueOrText(m, ALIAS_A), { centerElement: true, timeout: 7_000 });
    await m.assertVisible(valueOrText(m, ALIAS_B));
    await m.scrollUntilVisible("Active from", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.assertVisible(valueOrText(m, "1901"));
    await m.scrollUntilVisible("No teams yet.", { centerElement: true, timeout: 7_000 });

    // ── The league is a filter option on Team Management ──
    await m.openLink("/admin/teams");
    await m.waitVisible(".*of .* teams.*", 30_000);
    // Native <select>: Maestro taps it open, then sees the option text. Playwright
    // can't see an open popup, so focus the select and read its options by role.
    await m.page
      .getByRole("combobox")
      .filter({ has: m.page.getByRole("option", { name: mrx("All leagues") }) })
      .first()
      .click();
    await expect(m.page.getByRole("option", { name: mrx(ABBR) }).first()).toBeAttached({ timeout: 7_000 });
  },
);
