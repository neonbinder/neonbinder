// Port of .maestro/flows/set-selector/checklist-wizard-career-team-entry.yaml
import { test } from "../../support/fixtures";
import { mrx, type Maestro, type Relational } from "../../support/maestro";
import { utilFetchRealSetChecklistToWizard } from "../../support/subflows/set-selector/util-fetch-real-set-checklist-to-wizard";
import { utilDiscardResumedReviewBatch } from "../../support/subflows/set-selector/util-discard-resumed-review-batch";
import { utilWizardWalkToPlayerRow } from "../../support/subflows/set-selector/util-wizard-walk-to-player-row";

/**
 * Maestro's combined `{ id: <aria-label>, text: <value> }` selector: one node
 * with BOTH the accessible name and the value (input value / selected option).
 */
function idWithText(m: Maestro, id: string, text: string): Relational {
  const re = mrx(text);
  return {
    kind: "relational",
    description: `id ${JSON.stringify(id)} with text ${JSON.stringify(text)}`,
    probe: async () => {
      const cands = m.id(id);
      const n = await cands.count();
      for (let i = 0; i < n; i++) {
        const el = cands.nth(i);
        const v = await el
          .evaluate((e) =>
            e instanceof HTMLSelectElement
              ? (e.selectedOptions[0]?.text ?? "")
              : e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement
                ? e.value
                : ((e as HTMLElement).innerText ?? e.textContent ?? "").trim(),
          )
          .catch(() => null);
        if (v !== null && re.test(v)) return el;
      }
      return null;
    },
  };
}

test(
  "Entity review — a player row takes hand-entered career teams, refuses an entry with no from-year, and carries the staged history into the Add as New decision",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const T = env.ATTEMPT_TOKEN;

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    // SETUP — real set, real fetch, wizard open
    await utilFetchRealSetChecklistToWizard(m);
    await utilDiscardResumedReviewBatch(m);
    await m.assertVisible("0 of [0-9]+ reviewed.*");
    await utilWizardWalkToPlayerRow(m);

    // STEP 2 — R2(a): a PLAYER row, with the manual-entry affordance on it
    await m.assertVisible(m.id("Career team name"));

    // STEP 3 — R2(b): a name with no from-year is refused
    await m.tapOn(m.id("Career team name"));
    await m.inputText(`ProbeTeam${T}`);
    await m.tapOn(m.id("Add career team"));
    await m.assertVisible(idWithText(m, "Career team name", `.*ProbeTeam${T}.*`));
    await m.assertNotVisible(m.id("Staged career teams"));

    // STEP 4 — R2(c): a complete entry keeps its years across the New Team step
    await m.tapOn(m.id("From year"));
    await m.inputText("2001");
    await m.tapOn(m.id("To year \\(optional\\)"));
    await m.inputText("2005");
    await m.tapOn(m.id("Add career team"));

    await m.waitVisible(`New Team: ProbeTeam${T}|.*still looking up.*`, 7_000);
    await m.waitNotVisible(".*still looking up.*", 180_000);
    await m.waitVisible(`New Team: ProbeTeam${T}`, 7_000);

    // R2(f) NEO-307: a league CREATED from the League combobox raises its own step.
    // PORT-GAP: the flow's swipes (touch drags with a duration) scroll the wizard's
    // inner body; the driver's swipe scrolls the window and ignores duration. Kept
    // for step parity; Playwright's actionability scrolling reaches League anyway.
    await m.swipe({ start: "18%, 70%", end: "18%, 20%" });
    await m.waitVisible(m.id("League"), 7_000);
    await m.tapOn(m.id("League"));
    await m.inputText(`Lg${T}`);
    await m.tapOn(`Create .Lg${T}.`);
    await m.swipe({ start: "18%, 20%", end: "18%, 95%" });

    await m.waitVisible(`New League: Lg${T}`, 7_000);
    await m.tapOn(m.id("Add as New League"));

    await m.waitVisible(`New Team: ProbeTeam${T}`, 7_000);
    await m.swipe({ start: "18%, 70%", end: "18%, 20%" });
    await m.waitVisible(m.id("League"), 7_000);
    await m.waitVisible(idWithText(m, "League", `Lg${T} \\(new\\)`), 7_000);
    await m.swipe({ start: "18%, 20%", end: "18%, 95%" });

    await m.tapOn("Add as New Team");
    await m.waitVisible(m.id("Career team name"), 30_000);

    await m.assertVisible(`.*ProbeTeam${T} \\(2001.2005\\).*`);

    // STEP 5 — R2(d)/(g): optional to-year, Enter adds, a staged entry can be removed
    await m.tapOn(m.id("Career team name"));
    await m.inputText(`TempTeam${T}`);

    await m.tapOn(m.id("From year"));
    const copied = await m.copyTextFrom("[0-9]+ of [0-9]+ reviewed.*");
    const REVIEWED_BEFORE = copied.match(/^[0-9]+/)![0];

    await m.pressKey("Enter");
    await m.assertVisible(idWithText(m, "Career team name", `.*TempTeam${T}.*`));

    await m.inputText("2010");
    await m.pressKey("Enter");
    await m.waitNotVisible(idWithText(m, "From year", "2010"), 7_000);
    await m.waitVisible(`New Team: TempTeam${T}|.*still looking up.*`, 7_000);
    await m.waitNotVisible(".*still looking up.*", 180_000);
    await m.waitVisible(`New Team: TempTeam${T}`, 7_000);
    await m.assertVisible(`${REVIEWED_BEFORE} of [0-9]+ reviewed.*`);

    await m.swipe({ start: "18%, 70%", end: "18%, 20%" });
    await m.waitVisible(m.id("League"), 7_000);
    await m.tapOn(m.id("League"));
    await m.inputText(T);
    await m.tapOn(`Lg${T} \\(new\\)`);
    await m.waitVisible(idWithText(m, "League", `Lg${T} \\(new\\)`), 7_000);
    await m.swipe({ start: "18%, 20%", end: "18%, 95%" });
    await m.tapOn("Add as New Team");
    await m.waitVisible(m.id("Career team name"), 30_000);
    await m.assertVisible(`.*TempTeam${T} \\(2010.present\\).*`);
    await m.tapOn(m.id(`Remove TempTeam${T}`));
    await m.assertNotVisible(`.*TempTeam${T} \\(2010.present\\).*`);
    await m.assertVisible(`.*ProbeTeam${T} \\(2001.2005\\).*`);

    // STEP 6 — R2(e): the decision carries the staged entry, and the wizard moves on
    await m.tapOn("Add as New Player");
    await m.waitVisible("Added as new");
    await m.assertNotVisible(`.*ProbeTeam${T} \\(2001.2005\\).*`);

    // STEP 7 — exit without writing anything (R7)
    // "Cancel (Esc)" is a literal label; parentheses escaped for the regex-only driver.
    await m.tapOn("Cancel \\(Esc\\)"); // retryTapIfNoChange dropped
    await m.assertVisible("Discard [0-9]+ decisions?.*");
    await m.tapOn("Discard");
    await m.waitVisible("Fetch cancelled — no cards saved.");
  },
);
