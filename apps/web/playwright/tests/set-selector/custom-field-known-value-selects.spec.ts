// Port of .maestro/flows/set-selector/custom-field-known-value-selects.yaml
import { test } from "../../support/fixtures";

test(
  "Custom field — typing a known synced value selects it instead of creating a duplicate",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await m.waitVisible("Sports");
    await m.waitVisible("Baseball");

    await m.scrollUntilVisible(m.id("Add custom Sports"), { timeout: 7_000 });
    await m.retry(1, async () => {
      await m.tapOn(m.id("Add custom Sports"));
      await m.waitVisible("Add Custom Entry", 5_000);
    });

    // The form's text input is autofocused; no tap before typing.
    await m.inputText("Baseball");
    await m.pressKey("Enter");

    await m.waitNotVisible("Add Custom Entry");

    await m.scrollUntilVisible("Sync Years", { centerElement: true, timeout: 7_000 });
  },
);
