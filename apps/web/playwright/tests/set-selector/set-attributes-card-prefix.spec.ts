// Port of .maestro/flows/set-selector/set-attributes-card-prefix.yaml
import { test } from "../../support/fixtures";
import { mrx, type Maestro, type Relational } from "../../support/maestro";
import { utilDrillToCustomSet } from "../../support/subflows/set-selector/util-drill-to-custom-set";

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
  "SetAttributesPanel — Card prefix edits, persists across collapse/expand, and clears (per-worker custom set)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustomSet(m, { SET_NAME: `cpx-${env.WORKER_INDEX}`, VARIANT_TYPE: "Insert" });

    await m.scrollUntilVisible(m.id("Add custom Inserts"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Inserts"));
    await m.assertVisible("Add Custom Entry");
    await m.tapOn("Enter custom value...");
    await m.inputText("CPXROW");
    await m.pressKey("Enter");
    if (await m.isVisible(m.id("Create insert"))) {
      await m.tapOn(m.id("Create insert"));
    }
    await m.assertNotVisible("Add Custom Entry");

    await m.scrollUntilVisible("CPXROW", { centerElement: true, timeout: 7_000 });
    await m.tapOn("CPXROW");

    await m.scrollUntilVisible(m.id("Edit attributes"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Edit attributes"));
    await m.assertVisible(m.id("Hide attributes"));

    await m.scrollUntilVisible(m.id("Value for Card prefix"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Value for Card prefix"));
    await m.eraseText(30);
    await m.inputText("ZZ-");
    await m.pressKey("Enter");
    await m.waitVisible(".*Saved Card prefix.*", 7_000);

    await m.tapOn(m.id("Value for Card prefix"));
    await m.eraseText(30);
    await m.inputText("CPX-");
    await m.pressKey("Enter");
    await m.waitVisible(".*Saved Card prefix.*", 7_000);

    await m.scrollUntilVisible(m.id("Hide attributes"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id("Hide attributes"));
    await m.assertVisible(m.id("Edit attributes"));
    await m.tapOn(m.id("Edit attributes"));
    await m.assertVisible(m.id("Hide attributes"));

    await m.scrollUntilVisible(idText(m, "Value for Card prefix", "CPX-"), {
      centerElement: true,
      timeout: 7_000,
    });

    await m.tapOn(m.id("Value for Card prefix"));
    await m.eraseText(30);
    await m.assertVisible(idText(m, "Value for Card prefix", "e.g. DK-"));
    await m.pressKey("Enter");
    await m.waitVisible(".*Cleared Card prefix.*", 7_000);

    await m.scrollUntilVisible(m.id("Hide attributes"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.tapOn(m.id("Hide attributes"));
    await m.assertVisible(m.id("Edit attributes"));
    await m.tapOn(m.id("Edit attributes"));
    await m.assertVisible(m.id("Hide attributes"));

    await m.scrollUntilVisible(idText(m, "Value for Card prefix", "e.g. DK-"), { timeout: 7_000 });
    await m.assertNotVisible(idText(m, "Value for Card prefix", ".*CPX-.*"));
    await m.assertVisible("Card prefix");
  },
);
