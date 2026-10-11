// Port of .maestro/flows/set-selector/reconcile-sportlots-twins-keep-their-own-ids.yaml
import { test } from "../../support/fixtures";
import { mrx, type Maestro, type Relational } from "../../support/maestro";
import { utilDrillTo2024ToppsChrome } from "../../support/subflows/set-selector/util-drill-to-2024-topps-chrome";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

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
  "Reconcile — SportLots twins show their ids, filter cleanly, make their own sets by id and block Save on one title; the twin that is no parallel of the Base is set aside (NEO-325, read-only)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const TWIN = "Chrome Update Sapphire";
    const TWIN_A = "326059";
    const TWIN_B = "323331";
    const BR = "Chrome Black Refractor";
    const BR_MATCH = "309103";
    const BR_OTHER = "305604";

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillTo2024ToppsChrome(m);

    await m.scrollUntilVisible("Parallel", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Parallel");
    await m.waitVisible("Parallels", 7_000);

    await m.scrollUntilVisible("Sync Parallels", { centerElement: true, timeout: 7_000 });

    utilPausedPlatforms(m);
    if (env.SL_PAUSED) {
      await m.assertVisible("Parallels");
    }

    if (!env.SL_PAUSED) {
      await m.tapOn("Sync Parallels");
      await m.waitVisible("Reconcile Parallels", 60_000);

      // Part 1: the BSC / NeonBinder filters
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.tapOn(m.id("Filter NeonBinder sets"));
      await m.inputText("Update Sapphire Black");
      await m.waitVisible(".*Ready \\(0 of [0-9]+\\).*", 7_000);
      await m.tapOn(m.id("Filter BSC items"));
      await m.inputText("Update Sapphire");
      await m.waitVisible(".*BSC \\(0 of [0-9]+\\).*", 7_000);
      await m.assertNotVisible(".*so you can tell them apart\\..*");

      // Part 2: Chrome Black Refractor — one twin matches the Base, the other is set aside
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.swipe({ start: "3%, 75%", end: "3%, 25%" });
      await m.tapOn(m.id("Search SportLots items"));
      await m.inputText(BR);
      await m.waitVisible(m.id(`${BR} \\(#${BR_MATCH}\\) — Matches the Base`), 120_000);
      await m.assertVisible(m.id(`Make its own set: ${BR} \\(#${BR_MATCH}\\)`));
      await m.waitVisible(m.id("[0-9]+ that don.t match the Base, SportLots"), 120_000);
      await m.waitNotVisible(m.id(`Make its own set: ${BR} \\(#${BR_OTHER}\\)`), 120_000);
      await m.tapOn(m.id("[0-9]+ that don.t match the Base, SportLots"));
      // Maestro: a row containing the "Doesn't match the Base" reason AND the OTHER twin's
      // button. Approximated by the reason text sitting below that button (no CSS/XPath).
      await m.waitVisible(
        m.below("Doesn.t match the Base.*", m.id(`Make its own set: ${BR} \\(#${BR_OTHER}\\)`)),
        7_000,
      );
      await m.tapOn(m.id("[0-9]+ that don.t match the Base, SportLots"));
      await m.waitNotVisible(
        m.below("Doesn.t match the Base.*", m.id(`Make its own set: ${BR} \\(#${BR_OTHER}\\)`)),
        7_000,
      );
      await m.assertVisible(m.id(`Make its own set: ${BR} \\(#${BR_MATCH}\\)`));
      await m.assertVisible(m.id("[0-9]+ that don.t match the Base, SportLots"));
      await m.assertNotVisible(m.id(`Make its own set: ${BR} \\(#${BR_OTHER}\\)`));

      await m.assertVisible(
        m.above(
          m.below(
            m.id("[0-9]+ that don.t match the Base, SportLots"),
            m.id("Clear search sportlots items"),
          ),
          "Cancel",
        ),
      );
      await m.tapOn(m.id("Clear search sportlots items"));
      await m.waitVisible(idText(m, "Search SportLots items", "Search SportLots items\\.\\.\\."), 7_000);
      await m.tapOn(m.id("[0-9]+ that don.t match the Base, SportLots"));
      await m.waitVisible("Doesn.t match the Base.*", 7_000);

      // Part 3: the Update Sapphire twins
      await m.tapOn(m.id("Search SportLots items"));
      await m.inputText("Update Sapphire");
      await m.waitVisible(
        m.below("Doesn.t match the Base.*", m.id(`Make its own set: ${TWIN} \\(#${TWIN_A}\\)`)),
        120_000,
      );
      await m.waitVisible(
        m.below("Doesn.t match the Base.*", m.id(`Make its own set: ${TWIN} \\(#${TWIN_B}\\)`)),
        120_000,
      );

      await m.inputText(" Black");
      await m.waitVisible(m.id(`Make its own set: ${TWIN} Black.*`), 7_000);
      await m.assertVisible(".*SportLots \\([0-9]+ of [0-9]+\\).*");
      await m.assertNotVisible(m.id(`Make its own set: ${TWIN} \\(#[0-9]+\\)`));

      await m.eraseText(6);
      await m.waitVisible(m.id(`Make its own set: ${TWIN} \\(#${TWIN_A}\\)`), 7_000);

      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.swipe({ start: "3%, 75%", end: "3%, 25%" });
      await m.swipe({ start: "3%, 75%", end: "3%, 60%" });
      await m.assertVisible(
        m.above(
          m.below(
            m.id(`Make its own set: ${TWIN} [A-Za-z].*`),
            m.id(`Make its own set: ${TWIN} \\(#${TWIN_A}\\)`),
          ),
          "Cancel",
        ),
      );
      await m.tapOn(m.id(`Make its own set: ${TWIN} \\(#${TWIN_A}\\)`));
      await m.waitVisible(m.id(`Make its own set: ${TWIN} \\(#${TWIN_B}\\)`), 7_000);
      await m.assertNotVisible(m.id(`Make its own set: ${TWIN} \\(#${TWIN_A}\\)`));

      await m.assertVisible(
        m.above(
          m.below(
            m.id(`Make its own set: ${TWIN} [A-Za-z].*`),
            m.id(`Make its own set: ${TWIN} \\(#${TWIN_B}\\)`),
          ),
          "Cancel",
        ),
      );
      await m.tapOn(m.id(`Make its own set: ${TWIN} \\(#${TWIN_B}\\)`));
      await m.waitVisible(m.id(`Make its own set: ${TWIN} [A-Za-z].*`), 7_000);
      await m.assertNotVisible(m.id(`Make its own set: ${TWIN} \\(#[0-9]+\\)`));

      // Part 4: both Ready sets share one title -> Save is blocked until one is renamed
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.swipe({ start: "3%, 30%", end: "3%, 80%" });
      await m.tapOn(m.id("Clear filter neonbinder sets"));
      await m.inputText("Update Sapphire");
      await m.waitVisible(".*Ready \\(2 of [0-9]+\\).*", 7_000);
      await m.assertVisible(m.id(`Remove ${TWIN} \\(#${TWIN_A}\\) from ${TWIN} \\(#${TWIN_A}\\)`));
      await m.assertVisible(m.id(`Remove ${TWIN} \\(#${TWIN_B}\\) from ${TWIN} \\(#${TWIN_B}\\)`));

      await m.assertVisible(`.*Two sets are both named .${TWIN}.\\. Rename one so you can tell them apart\\..*`);
      await m.assertVisible(
        idText(
          m,
          `Two sets are both named .${TWIN}.\\. Rename one so you can tell them apart\\.`,
          ".*Save [0-9]+ sets.*",
        ),
      );

      await m.tapOn(m.id(`NeonBinder set name for ${TWIN} \\(#${TWIN_A}\\)`));
      await m.inputText(" Second");
      await m.tapOn("Reconcile Parallels");
      await m.waitVisible(m.id(`Remove ${TWIN} \\(#${TWIN_B}\\) from ${TWIN}`), 7_000);
      await m.assertVisible(m.id(`Remove ${TWIN} \\(#${TWIN_A}\\) from ${TWIN} Second`));
      await m.assertNotVisible(".*so you can tell them apart\\..*");
      await m.assertVisible(".*Save [0-9]+ sets.*");
      await m.assertNotVisible(idText(m, "Two sets are both named.*", ".*Save [0-9]+ sets.*"));

      // Read-only: leave without saving
      await m.tapOn(m.leftOf("Cancel", ".*Save [0-9]+ sets.*"));
      await m.waitVisible("Discard [0-9]+ set changes?", 7_000);
      await m.tapOn("Discard [0-9]+ set changes?");
      await m.waitNotVisible("Reconcile Parallels", 7_000);
      await m.scrollUntilVisible("Sync Parallels", { timeout: 7_000 });
    }
  },
);
