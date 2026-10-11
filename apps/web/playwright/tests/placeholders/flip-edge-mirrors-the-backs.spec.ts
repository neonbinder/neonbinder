// Port of .maestro/flows/placeholders/flip-edge-mirrors-the-backs.yaml
// The fixtures upload through /testing/seed-placeholder-upload (the entry URL), as in the flow.
import { test } from "../../support/fixtures";
import type { Locator } from "@playwright/test";
import type { Maestro, Relational, Sel } from "../../support/maestro";

/** One non-waiting visibility probe of any selector. */
async function probeSel(m: Maestro, sel: Sel): Promise<Locator | null> {
  if (typeof sel === "string") {
    const l = m.text(sel).first();
    return (await l.isVisible().catch(() => false)) ? l : null;
  }
  if ("probe" in sel) return sel.probe();
  return sel;
}

/**
 * Maestro `text: target, below: belowAnchor, leftOf: leftAnchor` — one element
 * that satisfies BOTH relations (the driver's m.below / m.leftOf take only one).
 */
function belowAndLeftOf(m: Maestro, target: string, belowAnchor: Sel, leftAnchor: Sel): Relational {
  return {
    kind: "relational",
    description: `${JSON.stringify(target)} below ${belowAnchor.toString()} and leftOf ${leftAnchor.toString()}`,
    probe: async () => {
      const below = await probeSel(m, belowAnchor);
      const left = await probeSel(m, leftAnchor);
      if (!below || !left) return null;
      const bBox = await below.boundingBox().catch(() => null);
      const lBox = await left.boundingBox().catch(() => null);
      if (!bBox || !lBox) return null;
      const cands = m.text(target);
      const n = await cands.count();
      for (let i = 0; i < n; i++) {
        const box = await cands.nth(i).boundingBox().catch(() => null);
        if (!box) continue;
        if (box.y >= bBox.y + bBox.height - 1 && box.x + box.width <= lBox.x + 1) return cands.nth(i);
      }
      return null;
    },
  };
}

test(
  "Print settings — the flip edge re-mirrors the backs, and backs can be turned off",
  { tag: ["@placeholders"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/testing/seed-placeholder-upload%3Ffixtures%3Dplaceholder-fixtures-fullbleed"));
    await m.waitVisible("Upload your cards", 90_000);

    await m.scrollUntilVisible("Your cards", { centerElement: true, timeout: 7_000 });
    await m.waitVisible("All 6 photos read.", 180_000);

    await m.scrollUntilVisible("Finish the batch", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Finish the batch");
    await m.assertVisible("Finish this batch?");
    await m.tapOn("Finish it");
    await m.waitVisible("3 pairs ready to print.", 7_000);

    await m.scrollUntilVisible(".*3 cards on 1 sheet of Letter, printed both sides.*", {
      centerElement: true,
      timeout: 7_000,
    });

    await m.scrollUntilVisible(".*Show cutting guides.*", { centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Show cutting guides.*");

    // Default (long edge): on the back sheet pocket 1 sits right of a 3 that sits right of a 3.
    await m.scrollUntilVisible(m.rightOf("1", m.rightOf("3", "3")), { centerElement: true, timeout: 7_000 });

    await m.scrollUntilVisible("Short edge", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn("Short edge");
    await m.scrollUntilVisible(belowAndLeftOf(m, "1", "3", m.below("2", "3")), {
      centerElement: true,
      timeout: 7_000,
    });

    await m.scrollUntilVisible(".*Print the backs too.*", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.tapOn(".*Print the backs too.*");
    await m.scrollUntilVisible(".*3 cards on 1 sheet of Letter, front only.*", {
      direction: "UP",
      centerElement: true,
      timeout: 7_000,
    });
    await m.scrollUntilVisible("Sheet 1 . front", { centerElement: true, timeout: 7_000 });
    await m.assertNotVisible("Sheet 1 . back");
  },
);
