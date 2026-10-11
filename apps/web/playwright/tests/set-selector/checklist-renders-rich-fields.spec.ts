// Port of .maestro/flows/set-selector/checklist-renders-rich-fields.yaml
import { test } from "../../support/fixtures";
import { utilDrillToBaseVariant } from "../../support/subflows/set-selector/util-drill-to-base-variant";

test(
  "Checklist — card rows render card number, sub-line, attribute badges, and platform badges",
  { tag: ["@set-selector"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/set-selector"));
    await m.waitVisible(".*Build set parameters using marketplace APIs.*", 45_000);

    await utilDrillToBaseVariant(m);

    // A FULL match on a row's number cell, never `.*#[0-9].*` (twin notices).
    await m.scrollUntilVisible("#[0-9][^ ]*", { centerElement: true, timeout: 7_000 });

    // BSC platform badge appears on at least one card row.
    await m.assertVisible("BSC");

    // scrollUntilVisible failing loudly is the RC assertion.
    await m.scrollUntilVisible("RC", { centerElement: true, timeout: 7_000 });
  },
);
