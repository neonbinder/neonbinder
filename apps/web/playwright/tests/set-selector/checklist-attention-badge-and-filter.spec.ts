// Port of .maestro/flows/set-selector/checklist-attention-badge-and-filter.yaml
import { test, expect } from "../../support/fixtures";
import { mrx } from "../../support/maestro";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

test(
  "Checklist attention — a card with no team is badged, counted, and filterable",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const { ATTEMPT_ID, ATTEMPT_TOKEN } = env;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustom(m, {
      SPORT: "Baseball",
      YEAR: "2024",
      MANUFACTURER: "Topps",
      SET_NAME: `cna-${env.WORKER_INDEX}-${ATTEMPT_ID}`,
      VARIANT_TYPE: "Insert",
      VARIANT: "Base",
    });

    const edit = (n: number) => m.id(`Edit card ${n}-${ATTEMPT_ID}(, .*)?`);
    const badge = (n: number) => m.id(`Card ${n}-${ATTEMPT_ID}(, .*)? needs attention: no team on this card yet`);
    // assertVisible: id + text (an input's value)
    const assertFieldValue = async (label: string, pattern: string) => {
      const field = await m.resolve(m.id(label));
      await expect(field).toHaveValue(mrx(pattern), { timeout: 7_000 });
    };

    // Card A: no team
    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 15_000);
    await m.inputText(`701-${ATTEMPT_ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Attn Alpha ${ATTEMPT_ID}`);
    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.scrollUntilVisible(edit(701), { centerElement: true, timeout: 7_000 });

    // Card B: no team
    await m.scrollUntilVisible(m.id("Open add card form"), { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.inputText(`702-${ATTEMPT_ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Attn Bravo ${ATTEMPT_ID}`);
    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.scrollUntilVisible(edit(702), { centerElement: true, timeout: 7_000 });

    // Card C: has a team
    await m.scrollUntilVisible(m.id("Open add card form"), { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 7_000);
    await m.inputText(`703-${ATTEMPT_ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Attn Charlie ${ATTEMPT_ID}`);

    await m.scrollUntilVisible(m.id("Add team"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add team"));
    await m.assertVisible(m.id("Search teams"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`CNAB${ATTEMPT_TOKEN}`);
    await m.tapOn(m.id(`New team CNAB${ATTEMPT_TOKEN}`));

    await m.assertVisible(`New team: CNAB${ATTEMPT_TOKEN}`);
    await assertFieldValue("New team name", `CNAB${ATTEMPT_TOKEN}`);

    await m.tapOn(m.id(`Create team CNAB${ATTEMPT_TOKEN}`));
    await m.assertVisible(m.id(`Remove team CNAB${ATTEMPT_TOKEN}`));

    await m.tapOn(m.id("Card name"));
    await m.waitNotVisible(m.id("Search teams"), 7_000);

    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));
    await m.scrollUntilVisible(edit(703), { centerElement: true, timeout: 7_000 });

    await m.assertVisible(`.*CNAB${ATTEMPT_TOKEN}.*`);
    await m.assertNotVisible(badge(703));

    await m.scrollUntilVisible(badge(701), { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.assertVisible(badge(702));

    await m.scrollUntilVisible("2 need attention", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.assertVisible("Fix them one at a time");

    // Fix card B through the drawer
    await m.scrollUntilVisible(edit(702), { centerElement: true, timeout: 7_000 });
    await m.tapOn(edit(702));
    await m.waitVisible(m.id("Card name"), 15_000);

    await m.tapOn(m.id("Add team"));
    await m.assertVisible(m.id("Search teams"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`CNAA${ATTEMPT_TOKEN}`);
    await m.assertVisible(m.id(`New team CNAA${ATTEMPT_TOKEN}`));
    await m.tapOn(m.id(`New team CNAA${ATTEMPT_TOKEN}`));

    await m.assertVisible(`New team: CNAA${ATTEMPT_TOKEN}`);
    await assertFieldValue("New team name", `CNAA${ATTEMPT_TOKEN}`);

    await m.tapOn(m.id(`Create team CNAA${ATTEMPT_TOKEN}`));

    await m.assertVisible(m.id(`Remove team CNAA${ATTEMPT_TOKEN}`));
    await m.waitVisible(".*Saved Teams.*", 7_000);

    await m.tapOn(m.id("Card name"));
    await m.tapOn(m.id("Done editing card"));

    await m.waitNotVisible(badge(702), 7_000);
    await m.assertVisible(badge(701));
    await m.assertVisible("1 need attention");
    await m.assertVisible(`.*CNAA${ATTEMPT_TOKEN}.*`);

    // Filter
    await m.scrollUntilVisible(m.id("Show only cards needing attention"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id("Show only cards needing attention"));

    await m.waitNotVisible(`Attn Bravo ${ATTEMPT_ID}`, 7_000);
    await m.assertVisible(`Attn Alpha ${ATTEMPT_ID}`);
    await m.assertNotVisible(`Attn Charlie ${ATTEMPT_ID}`);

    await m.tapOn(m.id("Show only cards needing attention \\(on\\)"));
    await m.waitVisible(`Attn Bravo ${ATTEMPT_ID}`, 7_000);
  },
);
