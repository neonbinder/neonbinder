// Port of .maestro/flows/set-selector/card-detail-panel.yaml
import { test } from "../../support/fixtures";
import type { Maestro, Relational } from "../../support/maestro";
import { mrx } from "../../support/maestro";
import { utilAddCustomCard } from "../../support/subflows/set-selector/util-add-custom-card";

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
  "Card detail drawer — every field autosaves as you leave it (no Save button)",
  { tag: ["@set-selector"] },
  async ({ m, env }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);
    await utilAddCustomCard(m, { SET_NAME: `cd-${env.WORKER_INDEX}`, VARIANT_TYPE: "Insert", INSERT_NAME: "Base", CARD_NUMBER: `888-${env.ATTEMPT_ID}`, PLAYER_NAME: `Detail Panel Test ${env.ATTEMPT_ID}` });
    await m.tapOn(m.id(`Edit card 888-${env.ATTEMPT_ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 15_000);
    await m.assertVisible(`.*Card #888-${env.ATTEMPT_ID}.*`);
    await m.assertVisible("Changes save as you leave each field.");
    await m.assertVisible(m.id("Done editing card"));
    await m.tapOn(m.id("Card name"));
    await m.eraseText(60);
    await m.inputText(`Renamed Detail Player ${env.ATTEMPT_ID}`);
    await m.pressKey("Enter");
    await m.waitVisible(".*Saved Card name.*", 7_000);
    await m.assertVisible(m.id("Card title"));
    await m.tapOn(m.id("Card title"));
    await m.inputText(`T${env.ATTEMPT_ID}`);
    await m.pressKey("Enter");
    await m.waitVisible(".*Saved Card title.*", 7_000);
    await m.assertVisible(m.id("Card description"));
    await m.tapOn(m.id("Card description"));
    await m.inputText(`NEO-25 description body for ${env.ATTEMPT_ID}`);
    await m.tapOn(m.id("Card name"));
    await m.waitVisible(".*Saved Card description.*", 7_000);
    await m.scrollUntilVisible(m.id("Toggle RC"), { timeout: 7_000 });
    await m.tapOn(m.id("Toggle RC"));
    await m.waitVisible(".*Saved Attributes.*", 7_000);
    await m.waitVisible(m.id("Print run"), 7_000);
    await m.tapOn(m.id("Print run"));
    await m.inputText("99");
    await m.pressKey("Enter");
    await m.waitVisible(".*Saved Print run.*", 7_000);
    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));
    await m.scrollUntilVisible(".*/99.*", { timeout: 7_000 });
    await m.scrollUntilVisible(m.id(`Edit card 888-${env.ATTEMPT_ID}(, .*)?`), { timeout: 7_000 });
    await m.tapOn(m.id(`Edit card 888-${env.ATTEMPT_ID}(, .*)?`));
    await m.waitVisible(m.id("Card name"), 15_000);
    await m.assertVisible(`.*Renamed Detail Player ${env.ATTEMPT_ID}.*`);
    await m.assertVisible(idWithText(m, "Card title", `.*T${env.ATTEMPT_ID}.*`));
    await m.assertVisible(idWithText(m, "Card description", `.*NEO-25 description body for ${env.ATTEMPT_ID}.*`));
    await m.scrollUntilVisible(m.id("Toggle RC"), { timeout: 7_000 });
    await m.waitVisible(idWithText(m, "Print run", "99"), 7_000);
    await m.tapOn(m.id("Print run"));
    await m.eraseText(10);
    await m.assertVisible(idWithText(m, "Print run", "e.g. 99"));
    await m.pressKey("Enter");
    await m.waitVisible(".*Cleared Print run.*", 7_000);
    await m.assertVisible(m.id("Done editing card"));
    await m.tapOn(m.id("Done editing card"));
    await m.assertNotVisible(m.id("Card name"));
    await m.scrollUntilVisible(`.*Renamed Detail Player ${env.ATTEMPT_ID}.*`, { timeout: 7_000 });
    await m.assertNotVisible(".*/99.*");
    await m.scrollUntilVisible(m.id(`Delete card 888-${env.ATTEMPT_ID}(, .*)?`), { timeout: 7_000 });
    await m.tapOn(m.id(`Delete card 888-${env.ATTEMPT_ID}(, .*)?`));
    await m.assertVisible("Confirm?");
    await m.tapOn(m.id(`Confirm delete card 888-${env.ATTEMPT_ID}(, .*)?`));
    await m.assertNotVisible(`Renamed Detail Player ${env.ATTEMPT_ID}`);
  },
);
