// Port of .maestro/flows/placeholders/pipeline-escalation-cold-start.yaml
// The fixtures upload through /testing/seed-placeholder-upload (the entry URL), as in the flow.
import { test } from "../../support/fixtures";

test(
  "Placeholder pipeline (heavy escalation) — six photos past the heavy cap, cold-start notice, three pairs, none failed",
  { tag: ["@placeholders"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/testing/seed-placeholder-upload%3Ffixtures%3Dplaceholder-fixtures-corner"));
    await m.waitVisible("Upload your cards", 90_000);

    await m.scrollUntilVisible("Your cards", { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("Your cards", { timeout: 7_000 });

    await m.waitVisible(".*A few of these need a closer look.*", 120_000);
    await m.scrollUntilVisible(".*Escalating.*deeper processing.*", { timeout: 7_000 });
    await m.scrollUntilVisible("Your cards", { direction: "UP", timeout: 7_000 });

    await m.waitVisible("All 6 photos read.", 600_000);

    await m.scrollUntilVisible("Finish the batch", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Finish the batch");
    await m.assertVisible("Finish this batch?");
    await m.tapOn("Finish it");
    await m.waitVisible("3 pairs ready to print.", 7_000);
  },
);
