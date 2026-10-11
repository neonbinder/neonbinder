// Port of .maestro/flows/set-selector/features-propagation.yaml
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
  "Set-level feature edit saves that single row (Saved toast) and does NOT cascade to a card with its own value (per-worker custom set)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const W = env.WORKER_INDEX;
    const ID = env.ATTEMPT_ID;
    const drill = () =>
      utilDrillToCustom(m, {
        SPORT: "Baseball",
        YEAR: "2024",
        MANUFACTURER: "Topps",
        SET_NAME: `fp-${W}`,
      });
    const openAttributes = async () => {
      await m.scrollUntilVisible(m.id("Edit attributes"), { centerElement: true, timeout: 7_000 });
      if (await m.isVisible(m.id("Edit attributes"))) {
        await m.tapOn(m.id("Edit attributes"));
        await m.assertVisible(m.id("Hide attributes"));
      }
    };

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await drill();
    await m.assertVisible("Variant Types");

    // Phase 1: set-level edit
    await openAttributes();
    await m.assertVisible(m.id("Hide attributes"));

    await m.scrollUntilVisible(m.id("Value for Country of Origin"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Value for Country of Origin"));
    await m.eraseText(50);
    await m.inputText(`CooTest-SET1-${ID}`);
    await m.pressKey("Enter");
    await m.waitVisible(".*Saved Country of Origin.*", 7_000);

    // Phase 2: Insert > fp-insert > a card
    await m.scrollUntilVisible(m.id("Add custom Variant Types"), {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    if (await m.isNotVisible("Insert")) {
      await m.tapOn(m.id("Add custom Variant Types"));
      await m.assertVisible("Add Custom Entry");
      await m.inputText("Insert");
      await m.pressKey("Enter");
      if (await m.isVisible(m.id("Create variant type"))) {
        await m.tapOn(m.id("Create variant type"));
      }
      await m.waitNotVisible("Add Custom Entry");
      await m.assertVisible("Insert");
    }

    await m.scrollUntilVisible("Insert", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn("Insert");

    await m.assertVisible("Inserts");

    await m.scrollUntilVisible(m.id("Add custom Inserts"), { centerElement: true, timeout: 7_000 });

    if (await m.isNotVisible(`fp-insert-${W}`)) {
      await m.tapOn(m.id("Add custom Inserts"));
      await m.assertVisible("Add Custom Entry");
      await m.inputText(`fp-insert-${W}`);
      await m.pressKey("Enter");
      if (await m.isVisible(m.id("Create insert"))) {
        await m.tapOn(m.id("Create insert"));
      }
      await m.waitNotVisible("Add Custom Entry");
      await m.assertVisible(`.*fp-insert-${W}.*`);
    }

    await m.scrollUntilVisible(`fp-insert-${W}`, { centerElement: true, timeout: 7_000 });
    await m.tapOn(`fp-insert-${W}`);

    await m.scrollUntilVisible(m.id("Open add card form"), { centerElement: true, timeout: 7_000 });

    await m.tapOn(m.id("Open add card form"));
    await m.waitVisible(m.id("Card name"), 15_000);
    await m.inputText(`992-${ID}`);
    await m.tapOn("Player name");
    await m.inputText(`Propagation Test Player ${ID}`);
    await m.scrollUntilVisible(m.id("Submit new card"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Submit new card"));

    await m.scrollUntilVisible(`Propagation Test Player ${ID}`, { centerElement: true, timeout: 7_000 });

    // Phase 3: give the card its own value
    await m.scrollUntilVisible(m.id(`Edit card 992-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Edit card 992-${ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 15_000);

    await m.tapOn(m.id("Show features editor"));
    await m.assertVisible(m.id("Card features editor"));

    await m.scrollUntilVisible(m.id("Value for Country of Origin"), { timeout: 7_000 });
    await m.tapOn(m.id("Value for Country of Origin"));
    await m.eraseText(50);
    await m.inputText("CooTest-CARD");
    await m.pressKey("Enter");

    await m.waitVisible(idText(m, "Value for Country of Origin", ".*CooTest-CARD.*"), 7_000);

    await m.assertVisible(m.id("Done editing card"));
    await m.tapOn(m.id("Done editing card"));

    await m.scrollUntilVisible(`Propagation Test Player ${ID}`, { centerElement: true, timeout: 7_000 });

    // Phase 4: a second set-level edit must not cascade to the card
    await drill();
    await m.assertVisible("Variant Types");

    await openAttributes();

    await m.scrollUntilVisible(m.id("Value for Country of Origin"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Value for Country of Origin"));
    await m.eraseText(50);
    await m.inputText(`CooTest-SET2-${ID}`);
    await m.pressKey("Enter");
    await m.waitVisible(".*Saved Country of Origin.*", 7_000);

    await m.scrollUntilVisible("Insert", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn("Insert");

    await m.assertVisible("Inserts");

    await m.scrollUntilVisible(`fp-insert-${W}`, { centerElement: true, timeout: 7_000 });
    await m.tapOn(`fp-insert-${W}`);

    await m.scrollUntilVisible(m.id("Open add card form"), { centerElement: true, timeout: 7_000 });

    await m.scrollUntilVisible(m.id(`Edit card 992-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Edit card 992-${ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 15_000);

    await m.tapOn(m.id("Show features editor"));
    await m.assertVisible(m.id("Card features editor"));

    await m.scrollUntilVisible(idText(m, "Value for Country of Origin", ".*CooTest-CARD.*"), {
      timeout: 7_000,
    });

    await m.assertNotVisible(".*CooTest-SET2.*");

    await m.assertVisible(m.id("Done editing card"));
    await m.tapOn(m.id("Done editing card"));

    await m.scrollUntilVisible(`Propagation Test Player ${ID}`, { centerElement: true, timeout: 7_000 });

    // Cleanup
    await m.scrollUntilVisible(m.id(`Delete card 992-${ID}(, .*)?`), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 992-${ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 992-${ID}(, .*)?`));
    await m.assertNotVisible(`Propagation Test Player ${ID}`);
  },
);
