// Port of .maestro/flows/set-selector/checklist-title-length-limits-and-fixer.yaml
import { test } from "../../support/fixtures";
import { mrx, type Maestro, type Relational } from "../../support/maestro";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

/** Maestro `{ id: label, text: pattern }`: the labelled element whose value/text full-matches. */
function idWithText(m: Maestro, label: string, pattern: string): Relational {
  const re = mrx(pattern);
  return {
    kind: "relational",
    description: `id ${JSON.stringify(label)} with text ${JSON.stringify(pattern)}`,
    probe: async () => {
      const all = m.id(label);
      const n = await all.count();
      for (let i = 0; i < n; i++) {
        const v = await all
          .nth(i)
          .evaluate((e) =>
            e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement ? e.value : (e.textContent ?? ""),
          )
          .catch(() => null);
        if (v !== null && re.test(v)) return all.nth(i);
      }
      return null;
    },
  };
}

test(
  "Listing length limits — an over-long card title is refused, and an over-long variation is walked to a fix",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const { ATTEMPT_ID, ATTEMPT_TOKEN } = env;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustom(m, {
      SPORT: "Baseball",
      YEAR: "2024",
      MANUFACTURER: "Topps",
      SET_NAME: `tlf-${env.WORKER_INDEX}-${ATTEMPT_ID}`,
      VARIANT_TYPE: "Insert",
      VARIANT: "Base",
    });

    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 7_000);

    await m.inputText(`101-${ATTEMPT_ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Title Cap ${ATTEMPT_ID}`);

    await m.scrollUntilVisible(m.id("Add team"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add team"));
    await m.assertVisible(m.id("Search teams"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`TLF${ATTEMPT_TOKEN}`);
    await m.tapOn(m.id(`New team TLF${ATTEMPT_TOKEN}`));

    await m.assertVisible(`New team: TLF${ATTEMPT_TOKEN}`);
    await m.assertVisible(idWithText(m, "New team name", `TLF${ATTEMPT_TOKEN}`));

    await m.tapOn(m.id(`Create team TLF${ATTEMPT_TOKEN}`));
    await m.assertVisible(m.id(`Remove team TLF${ATTEMPT_TOKEN}`));

    await m.tapOn(m.id("Card name"));
    await m.waitNotVisible(m.id("Search teams"), 7_000);

    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));

    const edit = m.id(`Edit card 101-${ATTEMPT_ID}(, .*)?`);
    await m.scrollUntilVisible(edit, { centerElement: true, timeout: 7_000 });
    await m.tapOn(edit);
    await m.waitVisible(m.id("Card name"), 7_000);

    // CLAIM 1
    await m.assertVisible(m.id("Card title"));
    await m.tapOn(m.id("Card title"));
    await m.inputText("NEO101PAD-EXTREMELY-LONG-LISTING-TITLE-SUFFIX-THAT-BLOWS-PAST-THE-EIGHTY-CHARACTER-CAP");

    await m.assertVisible(".*over the 80-character limit.*");
    await m.assertVisible(".*Shorten it before saving.*");

    await m.pressKey("Enter");
    await m.assertNotVisible(".*Saved Card title.*");
    await m.assertVisible(m.id("Card name"));
    await m.assertVisible(idWithText(m, "Card title", ".*NEO101PAD.*"));
    await m.assertVisible(".*Shorten it before saving.*");

    await m.tapOn(m.id("Regenerate card title"));
    await m.assertVisible(".*Regenerate again to replace the title you have typed.*");
    await m.tapOn(m.id("Regenerate card title"));

    await m.waitNotVisible(idWithText(m, "Card title", ".*NEO101PAD.*"), 7_000);
    await m.assertVisible(idWithText(m, "Card title", `2024 Topps .*#101-${ATTEMPT_ID} TLF${ATTEMPT_TOKEN} Baseball`));
    await m.assertNotVisible(".*Shorten it before saving.*");

    // CLAIM 2
    await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
    await m.swipe({ start: "80%, 80%", end: "80%, 20%" });
    await m.swipe({ start: "80%, 80%", end: "80%, 20%" });

    await m.swipe({ start: "80%, 30%", end: "80%, 55%" });
    await m.waitVisible(m.id("Card variation"), 7_000);

    await m.tapOn(m.id("Card variation"));
    await m.inputText("Gold Refractor Image Variation Wearing Sunglasses Holding Bat In Dugout");

    await m.assertVisible(".*a marketplace that caps this field will reject the value.*");

    await m.pressKey("Enter");
    await m.waitVisible(".*Saved Variation.*", 7_000);
    await m.tapOn(m.id("Done editing card"));
    await m.waitNotVisible(m.id("Card name"), 7_000);

    const overBadge = m.id(`Card 101-${ATTEMPT_ID}(, .*)? needs attention: variation text is over the 65-character limit`);
    await m.scrollUntilVisible(overBadge, { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("1 need attention", { direction: "UP", centerElement: true, timeout: 7_000 });

    // CLAIM 3: the fixer
    await m.tapOn("Fix them one at a time");
    await m.waitVisible("Cards Needing Attention", 7_000);

    await m.assertVisible(m.id(`Skip card 101-${ATTEMPT_ID} for now`));
    await m.assertVisible(".*1 card needs attention . 0 fixed.*");
    await m.assertVisible("variation text is over the 65-character limit");

    await m.assertVisible(
      idWithText(m, `Card title for #101-${ATTEMPT_ID}`, `2024 Topps .*#101-${ATTEMPT_ID} TLF${ATTEMPT_TOKEN} Baseball`),
    );

    await m.assertVisible("Save \\(Enter\\)");
    await m.tapOn(m.id(`Card variation for #101-${ATTEMPT_ID}`));
    await m.eraseText(90);
    await m.waitNotVisible(".*a marketplace that caps this field will reject the value.*", 7_000);

    await m.tapOn("Save \\(Enter\\)");

    await m.waitVisible(".*All clear.*nothing on this checklist needs attention.*", 7_000);
    await m.assertVisible(".*0 cards need attention . 1 fixed.*");

    await m.tapOn("Done \\(Esc\\)");
    await m.waitNotVisible("Cards Needing Attention", 7_000);

    await m.waitNotVisible(overBadge, 7_000);
    await m.assertNotVisible("Fix them one at a time");
    await m.assertVisible(`#101-${ATTEMPT_ID}`);
  },
);
