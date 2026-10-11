// Port of .maestro/flows/set-selector/checklist-wizard-link-commits.yaml
import { test } from "../../support/fixtures";
import { utilAddPlayerByHand } from "../../support/subflows/admin/util-add-player-by-hand";
import { utilFetchRealSetChecklistToWizard } from "../../support/subflows/set-selector/util-fetch-real-set-checklist-to-wizard";
import { utilWizardWalkToPlayerRow } from "../../support/subflows/set-selector/util-wizard-walk-to-player-row";

test(
  "Entity review — Link to Existing decisions, including one to a player of another sport, are carried through Confirm & Save into the committed checklist",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/admin/players"));
    await m.waitVisible(".*of .* players.*", 45_000);

    const ATTEMPT_TOKEN = env.ATTEMPT_TOKEN;
    await utilAddPlayerByHand(m, { PLAYER_NAME: `Gw${ATTEMPT_TOKEN}`, SPORT: "Football" });

    await utilFetchRealSetChecklistToWizard(m, { SET: "Topps Brooklyn Collection" });

    await m.assertVisible("0 of [0-9]+ reviewed.*");

    await utilWizardWalkToPlayerRow(m);

    await m.retry(2, async () => {
      await m.tapOn(m.id("Link to existing instead"));
      await m.waitVisible(m.id("Search existing players"), 10_000);
    });
    await m.tapOn(m.id("Search existing players"));
    await m.inputText("Ohtani");
    await m.waitVisible(m.id("Link to Shohei Ohtani"));
    await m.tapOn(m.id("Link to Shohei Ohtani"));
    await m.waitVisible("Linked to Shohei Ohtani");

    await utilWizardWalkToPlayerRow(m);

    await m.assertVisible(m.id("Sport for this name: Baseball"));
    await m.tapOn(m.id("Sport for this name: Baseball"));
    await m.waitVisible(m.id("Choose a sport"), 7_000);

    await m.inputText("F");
    await m.assertVisible(
      m.above(m.below("Football", m.id("Sport for this name: Baseball")), m.id("Decision for .*")),
    );
    await m.tapOn(m.within(m.id("Choose a sport"), "Football"));
    await m.waitVisible(m.id("Sport for this name: Football"), 7_000);

    await utilWizardWalkToPlayerRow(m);
    await m.assertVisible(m.id("Sport for this name: Football"));

    await m.retry(2, async () => {
      await m.tapOn(m.id("Link to existing instead"));
      await m.waitVisible(m.id("Search existing players"), 7_000);
    });
    await m.tapOn(m.id("Search existing players"));
    await m.inputText(`Gw${ATTEMPT_TOKEN}`);
    await m.waitVisible(m.id(`Link to Gw${ATTEMPT_TOKEN}`), 7_000);
    await m.tapOn(m.id(`Link to Gw${ATTEMPT_TOKEN}`));

    await m.waitNotVisible(m.id("Sport for this name: Football"), 7_000);
    await m.assertVisible(m.id("Sport for this name: Baseball"));

    await m.tapOn(".*Skip remaining names \\([0-9]+\\).*");
    await m.waitVisible(".*Confirm & Save.*", 120_000);
    await m.tapOn(".*Confirm & Save.*");
    await m.waitVisible(".*Saved [0-9]+ cards.*", 60_000);

    await m.openLink("/admin/players");
    await m.waitVisible(".*of .* players.*", 20_000);
    await m.tapOn("Filter players");
    await m.inputText(`Gw${ATTEMPT_TOKEN}`);
    await m.waitVisible(".*matches.*", 7_000);
    await m.tapOn(m.below(`Gw${ATTEMPT_TOKEN}`, ".*matches.*"));

    await m.scrollUntilVisible(m.id(`Cards for Gw${ATTEMPT_TOKEN}`), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.assertVisible(m.within(m.id(`Cards for Gw${ATTEMPT_TOKEN}`), ".*Brooklyn Collection.*"));
    await m.assertVisible(m.within(m.id(`Cards for Gw${ATTEMPT_TOKEN}`), "Baseball"));
  },
);
