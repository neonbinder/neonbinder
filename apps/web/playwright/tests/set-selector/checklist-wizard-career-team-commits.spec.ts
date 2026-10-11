// Port of .maestro/flows/set-selector/checklist-wizard-career-team-commits.yaml
import { test } from "../../support/fixtures";
import { utilFetchRealSetChecklistToWizard } from "../../support/subflows/set-selector/util-fetch-real-set-checklist-to-wizard";
import { utilWizardWalkToPlayerRow } from "../../support/subflows/set-selector/util-wizard-walk-to-player-row";

test(
  "Entity review — a hand-staged career team survives the commit and becomes a real team row",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    // output.ATTEMPT_TOKEN is env.ATTEMPT_TOKEN (PORTING.md)
    await utilFetchRealSetChecklistToWizard(m, { SET: "Topps Baltimore Orioles" });
    await m.assertVisible("0 of [0-9]+ reviewed.*");
    await utilWizardWalkToPlayerRow(m);
    await m.assertVisible(m.id("Career team name"));
    await m.tapOn(m.id("Career team name"));
    await m.inputText(`MintedTeam${env.ATTEMPT_TOKEN}`);
    await m.tapOn(m.id("From year"));
    await m.inputText("2001");
    await m.tapOn(m.id("To year \\(optional\\)"));
    await m.inputText("2005");
    await m.tapOn(m.id("Add career team"));
    await m.waitVisible(`New Team: MintedTeam${env.ATTEMPT_TOKEN}|.*still looking up.*`, 7_000);
    await m.waitNotVisible(".*still looking up.*", 180_000);
    await m.waitVisible(`New Team: MintedTeam${env.ATTEMPT_TOKEN}`, 7_000);
    await m.tapOn("Add as New Team");
    await m.waitVisible(m.id("Career team name"), 30_000);
    await m.assertVisible(`.*MintedTeam${env.ATTEMPT_TOKEN} \\(2001.2005\\).*`);
    await m.tapOn("Add as New Player");
    await m.waitVisible("Added as new");
    await m.tapOn(".*Skip remaining names \\([0-9]+\\).*");
    await m.waitVisible(".*Confirm & Save.*", 120_000);
    await m.tapOn(".*Confirm & Save.*");
    await m.waitVisible(".*Saved [0-9]+ cards.*", 60_000);
    await m.openLink("/admin/teams");
    await m.waitVisible(".*of .* teams.*", 30_000);
    await m.inputText(`MintedTeam${env.ATTEMPT_TOKEN}`);
    await m.waitVisible("1 of .* teams.*", 15_000);
    await m.assertVisible(m.below(`MintedTeam${env.ATTEMPT_TOKEN}`, "1 of .* teams.*"));
  },
);
