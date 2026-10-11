// Port of .maestro/flows/set-selector/set-attributes-edit.yaml
import { test } from "../../support/fixtures";
import { mrx, type Maestro, type Relational } from "../../support/maestro";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

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
  "SetAttributesPanel — breadcrumb scope, metadata editing, CLEARING an attribute, collapse/expand, child scope (per-worker custom set)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const W = env.WORKER_INDEX;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilDrillToCustom(m, {
      SPORT: "Baseball",
      YEAR: "2024",
      MANUFACTURER: "Topps",
      SET_NAME: `attr-edit-${W}`,
    });

    await m.scrollUntilVisible(m.id("Edit attributes"), { centerElement: true, timeout: 7_000 });
    if (await m.isVisible(m.id("Edit attributes"))) {
      await m.tapOn(m.id("Edit attributes"));
      await m.assertVisible(m.id("Hide attributes"));
    }
    await m.assertVisible(m.id("Hide attributes"));

    await m.assertVisible(`.*›.*attr-edit-${W}.*`);

    await m.scrollUntilVisible(m.id("Value for Total Cards"), { centerElement: true, timeout: 7_000 });
    await m.assertVisible(m.id("Value for Release Date"));

    await m.tapOn(m.id("Value for Release Date"));
    await m.eraseText(30);
    await m.inputText("1900-01-01");
    await m.pressKey("Enter");
    await m.waitVisible(".*Saved Release Date.*", 7_000);

    await m.tapOn(m.id("Value for Release Date"));
    await m.eraseText(30);
    await m.inputText("2024-08-01");
    await m.pressKey("Enter");
    await m.waitVisible(".*Saved Release Date.*", 7_000);

    await m.tapOn(m.id("Value for Release Date"));
    await m.eraseText(30);
    await m.assertVisible(idText(m, "Value for Release Date", "—"));
    await m.pressKey("Enter");
    await m.waitVisible(".*Cleared Release Date.*", 7_000);

    await m.tapOn(m.id("Value for Total Cards"));

    await m.assertVisible(idText(m, "Value for Release Date", "—"));
    await m.assertNotVisible(idText(m, "Value for Release Date", ".*2024-08-01.*"));

    await m.scrollUntilVisible(m.id("Hide attributes"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });

    await m.tapOn(m.id("Hide attributes"));
    await m.assertVisible(m.id("Edit attributes"));
    await m.assertNotVisible(m.id("Hide attributes"));

    await m.tapOn(m.id("Edit attributes"));
    await m.assertVisible(m.id("Hide attributes"));

    await m.scrollUntilVisible(m.id("Add custom Variant Types"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });

    if (await m.isNotVisible(`BaseAttr-${W}`)) {
      await m.tapOn(m.id("Add custom Variant Types"));
      await m.assertVisible("Add Custom Entry");
      await m.inputText(`BaseAttr-${W}`);
      await m.pressKey("Enter");
      if (await m.isVisible(m.id("Create variant type"))) {
        await m.tapOn(m.id("Create variant type"));
      }
      await m.waitNotVisible("Add Custom Entry");
      await m.assertVisible(`.*BaseAttr-${W}.*`);
    }

    await m.scrollUntilVisible(`BaseAttr-${W}`, { centerElement: true, timeout: 7_000 });
    await m.tapOn(`BaseAttr-${W}`);

    await m.assertVisible(`.*BaseAttr-${W}s.*`);

    await m.scrollUntilVisible(m.id("Edit attributes"), { centerElement: true, timeout: 7_000 });
    if (await m.isVisible(m.id("Edit attributes"))) {
      await m.tapOn(m.id("Edit attributes"));
      await m.assertVisible(m.id("Hide attributes"));
    }

    await m.assertVisible(`.*›.*BaseAttr-${W}.*`);
  },
);
