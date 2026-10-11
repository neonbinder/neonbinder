// Port of .maestro/flows/set-selector/column-reexpand-opens-at-selection.yaml
import { test } from "../../support/fixtures";
import type { Locator } from "@playwright/test";
import type { Maestro, Relational, Sel } from "../../support/maestro";
import { utilPausedPlatforms } from "../../support/subflows/util/util-paused-platforms";

/**
 * Maestro's `{ text, below: A, above: B }`: the nearest visible text match that
 * is both under anchor A's bottom and over anchor B's top. (m.below/m.above do
 * not compose: a relational target ignores the outer anchor.)
 */
function textBetween(m: Maestro, pattern: string, belowAnchor: Sel, aboveAnchor: Sel): Relational {
  const anchorBox = async (sel: Sel) => {
    const loc: Locator | null =
      typeof sel === "string"
        ? m.text(sel).first()
        : "kind" in sel
          ? await sel.probe()
          : sel.first();
    if (!loc) return null;
    if (!(await loc.isVisible().catch(() => false))) return null;
    return loc.boundingBox().catch(() => null);
  };
  return {
    kind: "relational",
    description: `text ${JSON.stringify(pattern)} between anchors`,
    probe: async () => {
      const a = await anchorBox(belowAnchor);
      const b = await anchorBox(aboveAnchor);
      if (!a || !b) return null;
      const cands = m.text(pattern);
      const n = await cands.count();
      for (let i = 0; i < n; i++) {
        const box = await cands.nth(i).boundingBox().catch(() => null);
        if (box && box.y >= a.y + a.height - 1 && box.y + box.height <= b.y + 1) return cands.nth(i);
      }
      return null;
    },
  };
}

test(
  "Set Builder cascade — re-expanding a collapsed column opens its list scrolled to the selected row, not to the top (NEO-276)",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    const SL_PAUSED = utilPausedPlatforms(m);

    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await m.waitVisible(m.id("Search sports"), 7_000);

    await m.tapOn(m.id("Search sports")); // waitToSettleTimeoutMs dropped
    await m.inputText("Racing");
    await m.retry(1, async () => {
      await m.tapOn(m.below("Racing", m.id("Search sports"))); // retryTapIfNoChange dropped
      await m.waitVisible("Years", 7_000);
    });

    await m.scrollUntilVisible(m.id("Sports: Racing — change"), { centerElement: true, timeout: 7_000 });
    await m.tapOn(m.id("Sports: Racing — change"));
    await m.waitVisible(m.id("Search sports"), 7_000);

    if (!SL_PAUSED) {
      await m.scrollUntilVisible(m.id("Add custom Sports"), { timeout: 7_000 });
      await m.waitVisible(m.id("Search sports"), 7_000);

      await m.waitVisible(textBetween(m, "Racing", m.id("Search sports"), m.id("Add custom Sports")), 7_000);
      await m.assertNotVisible(textBetween(m, "Baseball", m.id("Search sports"), m.id("Add custom Sports")));
    }
    if (SL_PAUSED) {
      await m.scrollUntilVisible(m.id("Dismiss Sports notice"), { timeout: 7_000 });
      await m.scrollUntilVisible(m.id("Search sports"), { direction: "UP", timeout: 7_000 });
      await m.assertVisible(m.id("Sports"));
      await m.waitVisible(m.below("Racing", m.id("Search sports")), 7_000);
      await m.assertNotVisible(m.below("Baseball", m.id("Search sports")));
    }
  },
);
