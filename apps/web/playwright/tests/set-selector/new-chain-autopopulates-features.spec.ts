// Port of .maestro/flows/set-selector/new-chain-autopopulates-features.yaml
import { test } from "../../support/fixtures";
import { mrx, type Maestro, type Relational } from "../../support/maestro";
import { utilDrillToCustom } from "../../support/subflows/set-selector/util-drill-to-custom";

/**
 * Maestro `{ id: label, text: pattern }`: the labelled element whose displayed
 * value (input value, selected option, or text) full-matches.
 */
function idWithText(m: Maestro, label: string, pattern: string): Relational {
  const re = mrx(pattern);
  return {
    kind: "relational",
    description: `id ${JSON.stringify(label)} with text ${JSON.stringify(pattern)}`,
    probe: async () => {
      const all = m.id(label);
      const n = await all.count();
      for (let i = 0; i < n; i++) {
        const shown = await all
          .nth(i)
          .evaluate((e) => {
            if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) return [e.value];
            if (e instanceof HTMLSelectElement) return [e.selectedOptions[0]?.text ?? "", e.value];
            return [(e.textContent ?? "").trim()];
          })
          .catch(() => [] as string[]);
        if (shown.some((s) => re.test(s))) return all.nth(i);
      }
      return null;
    },
  };
}

test(
  "Write-once feature snapshots — a freshly-built set chain auto-populates its SetAttributesPanel feature values with NO card-checklist step",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    const W = env.WORKER_INDEX;
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToCustom(m, {
      SPORT: `E2E Test Sport ${W}`,
      YEAR: "1975",
      MANUFACTURER: `WOMfr-${W}`,
      SET_NAME: `WOSet3-${W}`,
      VARIANT_TYPE: `WOVT3-${W}`,
    });

    await m.scrollUntilVisible(`.*Attributes for WOVT3-${W}.*`, { centerElement: true, timeout: 7_000 });

    await m.assertVisible(`.*1975.*WOVT3-${W}.*`);

    if (await m.isVisible(m.id("Edit attributes"))) {
      await m.tapOn(m.id("Edit attributes"));
      await m.assertVisible(m.id("Hide attributes"));
    }
    await m.assertVisible(m.id("Hide attributes"));

    await m.scrollUntilVisible(idWithText(m, "Value for Era", ".*1970-79.*"), { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible(idWithText(m, "Value for Card Thickness", "20pt"), {
      centerElement: true,
      timeout: 7_000,
    });
    await m.scrollUntilVisible(idWithText(m, "Value for Country of Origin", "USA"), {
      centerElement: true,
      timeout: 7_000,
    });
  },
);
