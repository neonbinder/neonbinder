// Port of .maestro/flows/placeholders/pipeline-pairs-uploaded-scans.yaml
// The fixtures upload through /testing/seed-placeholder-upload (the entry URL), as in the flow.
import { test } from "../../support/fixtures";

test(
  "Placeholder pipeline (fast path) — six frame-filling scans process fast and pair front-side-up whatever order they arrive in",
  { tag: ["@placeholders"] },
  async ({ m }) => {
    await m.launch(
      m.signInUrl("/testing/seed-placeholder-upload%3Ffixtures%3Dplaceholder-fixtures-fullbleed%26order%3Dback-first"),
    );
    await m.waitVisible("Upload your cards", 90_000);

    await m.scrollUntilVisible("Your cards", { centerElement: true, timeout: 7_000 });
    await m.waitVisible("All 6 photos read.", 180_000);

    await m.scrollUntilVisible("Finish the batch", { centerElement: true, timeout: 7_000 });
    await m.tapOn("Finish the batch");
    await m.assertVisible("Finish this batch?");
    await m.tapOn("Finish it");
    await m.waitVisible("3 pairs ready to print.", 7_000);

    await m.scrollUntilVisible("Check the pairs", { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("Front · 01-vorkle-front.jpg", { centerElement: true, timeout: 7_000 });

    await m.waitNotVisible(".*Loading image.*", 7_000);
    await m.assertNotVisible("Image unavailable");

    await m.scrollUntilVisible("Check the pairs", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("Back · 02-vorkle-back.jpg", { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("Check the pairs", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("Front · 03-quillden-front.jpg", { centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("Check the pairs", { direction: "UP", centerElement: true, timeout: 7_000 });
    await m.scrollUntilVisible("Front · 05-mossbaum-front.jpg", { centerElement: true, timeout: 7_000 });
  },
);
