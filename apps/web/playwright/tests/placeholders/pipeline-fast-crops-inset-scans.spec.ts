// Port of .maestro/flows/placeholders/pipeline-fast-crops-inset-scans.yaml
// The fixtures upload through /testing/seed-placeholder-upload (the entry URL), as in the flow.
import { test } from "../../support/fixtures";

test(
  "Placeholder pipeline (fast quad crop) — six cards on a scanner bed are cropped fast, no escalation, three pairs",
  { tag: ["@placeholders"] },
  async ({ m }) => {
    await m.launch(m.signInUrl("/testing/seed-placeholder-upload%3Ffixtures%3Dplaceholder-fixtures"));
    await m.waitVisible("Upload your cards", 90_000);

    await m.scrollUntilVisible("Your cards", { centerElement: true, timeout: 7_000 });
    await m.waitVisible("All 6 photos read.", 60_000);

    await m.scrollUntilVisible("Finish the batch", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Finish the batch");
    await m.waitVisible("Finish this batch?", 7_000);
    await m.tapOn("Finish it");
    await m.waitVisible("3 pairs ready to print.", 7_000);
  },
);
