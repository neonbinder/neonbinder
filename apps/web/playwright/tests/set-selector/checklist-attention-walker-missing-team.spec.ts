// Port of .maestro/flows/set-selector/checklist-attention-walker-missing-team.yaml
import { test, expect } from "../../support/fixtures";
import { mrx, type Maestro } from "../../support/maestro";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

/** Maestro `visible: { id: X, text: T }` — one element named X whose text (value, else placeholder) matches T. */
async function waitIdWithText(m: Maestro, id: string, textPattern: string, timeout: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const loc = m.id(id).first();
        if (!(await loc.isVisible().catch(() => false))) return null;
        const value = await loc.inputValue().catch(() => "");
        if (value) return value;
        return (await loc.getAttribute("placeholder")) ?? (await loc.getAttribute("aria-label")) ?? "";
      },
      { timeout, message: `id ${id} with text ${textPattern}` },
    )
    .toMatch(mrx(textPattern));
}

test(
  "Attention walker — answering a card's missing team, one card at a time",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const ID = env.ATTEMPT_ID;
    const TOKEN = env.ATTEMPT_TOKEN;
    const drillOpts = {
      SPORT: "Baseball",
      YEAR: "2024",
      MANUFACTURER: "Topps",
      SET_NAME: `cnw-${env.WORKER_INDEX}-${ID}`,
      VARIANT_TYPE: "Insert",
      VARIANT: "Base",
    };

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustom(m, drillOpts);

    // First card
    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 15_000);
    await m.inputText(`801-${ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Walker Alpha ${ID}`);
    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.scrollUntilVisible(m.id(`Edit card 801-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });

    // Second card, inline
    await m.scrollUntilVisible(m.id("Open add card form"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.inputText(`802-${ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Walker Bravo ${ID}`);
    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.scrollUntilVisible(m.id(`Edit card 802-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });

    // Open the walker
    await m.scrollUntilVisible("2 need attention", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn("Fix them one at a time");

    await m.waitVisible("Cards Needing Attention", 7_000);
    await m.assertVisible(m.id(`Skip card 801-${ID} for now`));
    await m.assertVisible(".*2 cards need attention . 0 fixed.*");
    await m.assertVisible("No players on this card.");
    await m.assertVisible("Pick at least one team, or record that this card has none.");

    // ANSWER 1 — skip #801
    await m.tapOn(m.id(`Skip card 801-${ID} for now`));
    await m.waitVisible(m.id(`Skip card 802-${ID} for now`), 7_000);
    await m.assertVisible(".*1 card needs attention . 0 fixed.*");

    // ANSWER 2 — no team on #802
    await m.tapOn("No team on this card");
    await m.waitVisible("All clear — nothing on this checklist needs attention.", 7_000);
    await m.assertVisible(".*0 cards need attention . 1 fixed.*");
    await m.tapOn("Done (Esc)");
    await m.waitNotVisible("Cards Needing Attention", 7_000);

    await m.waitNotVisible(m.id(`Card 802-${ID}(, .*)? needs attention: no team on this card yet`), 7_000);
    await m.assertVisible(m.id(`Card 801-${ID}(, .*)? needs attention: no team on this card yet`));
    await m.assertVisible("1 need attention");

    // ANSWER 3 — a real team for #801
    await m.tapOn("Fix them one at a time");
    await m.waitVisible(m.id(`Skip card 801-${ID} for now`), 7_000);
    await m.assertVisible(".*1 card needs attention . 0 fixed.*");

    await m.tapOn(m.id("Add team"));
    await m.assertVisible(m.id("Search teams"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`CNWT${TOKEN}`);

    await m.assertVisible("No matches.");

    await m.pressKey("Enter");

    await m.assertVisible(`New team: CNWT${TOKEN}`);
    await waitIdWithText(m, "New team name", `CNWT${TOKEN}`, 7_000);

    await m.tapOn(m.id(`Create team CNWT${TOKEN}`));

    await m.waitVisible(m.id(`Remove team CNWT${TOKEN}`), 7_000);

    // PORT-GAP: Maestro taps `id: "card-attention-walker-title"`, a real DOM id on the walker's
    // <h2>. A DOM id is not user-perceivable, so the same heading is tapped by its visible text.
    await m.tapOn("Cards Needing Attention");
    await m.waitNotVisible(m.id("Search teams"), 7_000);
    await m.tapOn(".*Save & Next.*");

    await m.waitVisible("All clear — nothing on this checklist needs attention.", 7_000);
    await m.assertVisible(".*0 cards need attention . 1 fixed.*");
    await m.tapOn("Done (Esc)");
    await m.waitNotVisible("Cards Needing Attention", 7_000);

    await m.waitNotVisible(m.id(`Card 801-${ID}(, .*)? needs attention: no team on this card yet`), 7_000);
    await m.assertNotVisible("Fix them one at a time");
    await m.assertVisible(`.*CNWT${TOKEN}.*`);

    // RELOAD via re-drill — the answers were written to the server
    await utilDrillToCustom(m, drillOpts);

    await m.scrollUntilVisible(`Walker Bravo ${ID}`, { centerElement: true, timeout: 7_000 });
    await m.assertVisible(`Walker Alpha ${ID}`);
    await m.assertNotVisible(m.id(`Card 802-${ID}(, .*)? needs attention: no team on this card yet`));
    await m.assertNotVisible(m.id(`Card 801-${ID}(, .*)? needs attention: no team on this card yet`));
    await m.assertNotVisible("Fix them one at a time");
  },
);
