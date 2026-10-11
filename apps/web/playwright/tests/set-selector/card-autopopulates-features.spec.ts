// Port of .maestro/flows/set-selector/card-autopopulates-features.yaml
import { test } from "../../support/fixtures";
import { mrx, type Relational } from "../../support/maestro";
import type { Maestro } from "../../support/maestro";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";

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
  "Write-once feature snapshots — a freshly-created CARD ROW auto-populates its own features with the inherited physical/production defaults from its ancestor chain",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilAddCustomCard(m, {
      SET_NAME: `cap-${env.WORKER_INDEX || 0}`,
      VARIANT_TYPE: "Insert",
      INSERT_NAME: "Base",
      CARD_NUMBER: `777-${env.ATTEMPT_ID}`,
      PLAYER_NAME: `Autopop Card Player ${env.ATTEMPT_ID}`,
    });

    const edit = m.id(`Edit card 777-${env.ATTEMPT_ID}(, .*)?`);
    await m.assertVisible(edit);
    await m.tapOn(edit); // waitToSettleTimeoutMs: 2000 dropped (no equivalent)
    await m.waitVisible(m.id("Card name"), 15_000);

    await m.assertVisible(m.id("Show features editor"));
    await m.tapOn(m.id("Show features editor"));
    await m.assertVisible(m.id("Card features editor"));

    await m.assertVisible(idWithText(m, "Value for Season", "2026"));

    await m.swipe({ start: "80%, 80%", end: "80%, 40%" });
    await m.assertVisible(idWithText(m, "Value for Country of Origin", "USA"));
    await m.assertVisible(idWithText(m, "Value for Card Size", "Standard"));
    await m.assertVisible(idWithText(m, "Value for Material", "Card Stock"));

    await m.swipe({ start: "80%, 80%", end: "80%, 40%" });
    await m.assertVisible(idWithText(m, "Value for Card Thickness", "20pt"));
    await m.assertVisible(idWithText(m, "Value for Language", "English"));

    await m.assertVisible(m.id("Done editing card"));
    await m.tapOn(m.id("Done editing card"));
    await m.scrollUntilVisible(m.id(`Delete card 777-${env.ATTEMPT_ID}(, .*)?`), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id(`Delete card 777-${env.ATTEMPT_ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 777-${env.ATTEMPT_ID}(, .*)?`));
    await m.assertNotVisible(`Autopop Card Player ${env.ATTEMPT_ID}`);
  },
);
