// Port of .maestro/flows/set-selector/custom-card-row-opens-panel-with-autotitle.yaml
import { test } from "../../support/fixtures";
import { mrx, type Maestro, type Relational } from "../../support/maestro";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";

/** Maestro's combined `{ id: <aria-label>, text: <value> }` selector. */
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
  "Card row — clicking the card NUMBER (not the name or Edit button) opens the detail panel, which shows an auto-generated Card title",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const A = env.ATTEMPT_ID;

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilAddCustomCard(m, {
      SET_NAME: `clt-${env.WORKER_INDEX || 0}`,
      VARIANT_TYPE: "Insert",
      INSERT_NAME: "Base",
      CARD_NUMBER: `779-${A}`,
      PLAYER_NAME: `Row Click Player ${A}`,
    });

    await m.scrollUntilVisible(`#779-${A}`, { centerElement: true, timeout: 7_000 });
    await m.tapOn(`#779-${A}`);

    await m.waitVisible(m.id("Card name"), 15_000);
    await m.assertVisible(`.*Card #779-${A}.*`);
    await m.assertVisible(idWithText(m, "Card title", `.*#779-${A}.*`));

    await m.assertVisible(m.id("Done editing card"));
    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));

    await m.scrollUntilVisible(m.id(`Delete card 779-${A}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 779-${A}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 779-${A}(, .*)?`));
    await m.assertNotVisible(`Row Click Player ${A}`);
  },
);
