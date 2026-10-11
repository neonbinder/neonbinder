// Port of .maestro/flows/set-selector/checklist-bsc-team-enrichment.yaml
import { test } from "../../support/fixtures";
import { mrx, type Maestro, type Relational } from "../../support/maestro";
import { utilDrillToBaseVariant } from "../../support/subflows/set-selector/util-drill-to-base-variant";

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
  "Checklist — a synced Base card carries its real BSC-resolved team into the card detail drawer (NEO-90, NEO-195)",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToBaseVariant(m);

    await m.scrollUntilVisible(m.id("Edit card 300(, .*)?"), { timeout: 7_000 });
    await m.tapOn(m.id("Edit card 300(, .*)?"));

    await m.waitVisible(m.id("Card name"), 15_000);
    await m.assertVisible(".*Card #300.*");
    await m.waitVisible(idText(m, "Card name", ".*Julio Rodriguez.*"), 15_000);

    await m.assertVisible("Teams");
    await m.assertVisible(m.id("Remove team Seattle Mariners"));

    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));
  },
);
