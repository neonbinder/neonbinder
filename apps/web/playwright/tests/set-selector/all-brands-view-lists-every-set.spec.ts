// Port of .maestro/flows/set-selector/all-brands-view-lists-every-set.yaml
import { test } from "../../support/fixtures";
import type { Maestro, Relational } from "../../support/maestro";
import { mrx } from "../../support/maestro";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

/**
 * Maestro selector `{ id, text }`: ONE element with this accessible name AND this
 * text (an input's value, or its placeholder when empty). No driver helper yet.
 */
function idWithText(m: Maestro, id: string, text: string): Relational {
  const re = mrx(text);
  return {
    kind: "relational",
    description: `id ${JSON.stringify(id)} with text ${JSON.stringify(text)}`,
    probe: async () => {
      const loc = m.id(id);
      const n = await loc.count();
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        const t = await el
          .evaluate((e) =>
            e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement
              ? e.value || e.placeholder
              : ((e as HTMLElement).innerText ?? e.textContent ?? "").trim(),
          )
          .catch(() => null);
        if (t !== null && re.test(t)) return el;
      }
      return null;
    },
  };
}

test(
  "All Brands is a pinned view — every set in the year with its brand, no + Custom, the brand back-filled on pick, and the name refused as a brand",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilDrillToCustom(m, { SPORT: `xb-sport-${env.WORKER_INDEX}`, YEAR: "2026" });
    await m.waitVisible(m.below("All Brands", m.id("Search manufacturers")), 7_000);
    await m.assertVisible(m.below("Every set in 2026", "All Brands"));
    await m.scrollUntilVisible(m.id("Add custom Manufacturers"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Add custom Manufacturers"));
    await m.waitVisible("Add Custom Entry", 7_000);
    await m.tapOn("Enter custom value...");
    await m.inputText("All Brands");
    await m.pressKey("Enter");
    await m.waitVisible("All Brands is the view at the top of this column, not a brand.", 7_000);
    await m.assertVisible("Add Custom Entry");
    await m.assertNotVisible(m.id("Create manufacturer"));
    await m.tapOn(m.id("Cancel new manufacturer"));
    await m.waitNotVisible("Add Custom Entry", 7_000);
    await m.assertVisible(m.id("Add custom Manufacturers"));
    await utilDrillToCustom(m, { SPORT: `xb-sport-${env.WORKER_INDEX}`, YEAR: "2026", MANUFACTURER: "Topps", SET_NAME: `xb-a-${env.WORKER_INDEX}` });
    await m.assertVisible("Variant Types");
    await utilDrillToCustom(m, { SPORT: `xb-sport-${env.WORKER_INDEX}`, YEAR: "2026", MANUFACTURER: "Panini", SET_NAME: `xb-b-${env.WORKER_INDEX}` });
    await m.assertVisible("Variant Types");
    await utilDrillToCustom(m, { SPORT: `xb-sport-${env.WORKER_INDEX}`, YEAR: "2026" });
    await m.scrollUntilVisible(m.below("All Brands", m.id("Search manufacturers")), { centerElement: true, timeout: 7_000 });
    await m.retry(1, async () => {
      await m.tapOn(m.below("All Brands", m.id("Search manufacturers")));
      await m.waitVisible("Sets", 7_000);
    });
    await m.scrollUntilVisible("Pick a brand to add a set", { timeout: 7_000 });
    await m.assertNotVisible(m.id("Add custom Sets"));
    await m.assertVisible(`xb-a-${env.WORKER_INDEX}`);
    await m.assertVisible(m.below("Topps", `xb-a-${env.WORKER_INDEX}`));
    await m.assertVisible(`xb-b-${env.WORKER_INDEX}`);
    await m.assertVisible(m.below("Panini", `xb-b-${env.WORKER_INDEX}`));
    await m.scrollUntilVisible(`xb-b-${env.WORKER_INDEX}`, { centerElement: true, timeout: 7_000 });
    await m.retry(1, async () => {
      await m.tapOn(`xb-b-${env.WORKER_INDEX}`);
      await m.waitVisible("Variant Types", 7_000);
    });
    await m.assertVisible(m.id("Manufacturers: Panini — change"));
    await m.assertVisible(m.id(`Sets: xb-b-${env.WORKER_INDEX} — change`));
    await utilDrillToCustom(m, { SPORT: `xb-sport-${env.WORKER_INDEX}`, YEAR: "2026", MANUFACTURER: "Panini" });
    await m.assertVisible("Sets");
    await m.scrollUntilVisible(m.id("Edit attributes"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Edit attributes"));
    await m.assertVisible(m.id("Hide attributes"));
    await m.scrollUntilVisible(idWithText(m, "Value for Brand", "Panini"), { timeout: 7_000 });
  },
);
