// Port of .maestro/flows/set-selector/team-picker-create-custom-card.yaml
import { test } from "../../support/fixtures";
import { mrx, type Maestro, type Relational } from "../../support/maestro";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";

/**
 * Maestro `{ id: A, text: B }`: ONE element whose accessible name matches A and
 * whose own text / input value / placeholder matches B (an input reads back its
 * value, or its placeholder when empty). The driver has no combined selector.
 */
function idText(m: Maestro, idPattern: string, textPattern: string): Relational {
  const re = mrx(textPattern);
  return {
    kind: "relational",
    description: `id ${JSON.stringify(idPattern)} with text ${JSON.stringify(textPattern)}`,
    probe: async () => {
      const els = m.id(idPattern);
      const n = await els.count();
      for (let i = 0; i < n; i++) {
        const el = els.nth(i);
        const texts = await el
          .evaluate((e) => {
            const f = e as HTMLInputElement;
            return [f.value, f.placeholder, (e as HTMLElement).innerText, e.textContent].filter(
              (s): s is string => typeof s === "string" && s !== "",
            );
          })
          .catch(() => [] as string[]);
        if (texts.some((t) => re.test(t))) return el;
      }
      return null;
    },
  };
}

test(
  "Team picker — create a brand-new team via the New Team dialog and attach it to a card; it persists across reopen",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const ID = env.ATTEMPT_ID;
    const T = env.ATTEMPT_TOKEN;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilAddCustomCard(m, {
      SET_NAME: `tpc-${env.WORKER_INDEX}`,
      VARIANT_TYPE: "Insert",
      INSERT_NAME: "Base",
      CARD_NUMBER: `776-${ID}`,
      PLAYER_NAME: `Team Create Card ${ID}`,
    });

    await m.assertVisible(m.id(`Edit card 776-${ID}(, .*)?`));
    await m.tapOn(m.id(`Edit card 776-${ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 15_000);

    await m.assertVisible(m.id("Team picker"));
    await m.assertVisible(m.id("Add team"));
    await m.tapOn(m.id("Add team"));
    await m.assertVisible(m.id("Search teams"));
    await m.tapOn(m.id("Search teams"));
    await m.inputText(`NBTeam${T}`);

    await m.assertVisible(m.id(`New team NBTeam${T}`));
    await m.tapOn(m.id(`New team NBTeam${T}`));

    await m.assertVisible(`New team: NBTeam${T}`);
    await m.assertVisible(idText(m, "New team name", `NBTeam${T}`));

    await m.tapOn(m.id(`Create team NBTeam${T}`));

    await m.assertVisible(m.id(`Remove team NBTeam${T}`));

    await m.waitVisible(".*Saved Teams.*", 7_000);

    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));

    // Reopen: the team persisted
    await m.scrollUntilVisible(m.id(`Edit card 776-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Edit card 776-${ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 15_000);

    await m.assertVisible(m.id(`Remove team NBTeam${T}`));

    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));

    await m.scrollUntilVisible(m.id(`Delete card 776-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 776-${ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 776-${ID}(, .*)?`));
    await m.assertNotVisible(`Team Create Card ${ID}`);
  },
);
