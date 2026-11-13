// Origin: .maestro/flows/placeholders/pipeline-fast-crops-inset-scans.yaml (Maestro suite retired in NEO-341; see git history)
// R1: cards centred on a scanner bed, dropped on the real /print/placeholders
// drop zone, are cropped by the fast quad stage: no escalation, three pairs.
// The 7 s after the last upload to "All 6 photos read." is what proves the fast
// path (six heavy escalations cannot settle inside it); NEO-529.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import {
  discardIfStillOpen,
  finishPlaceholderBatch,
  placeholderScans,
  startPlaceholderBatch,
} from "../../support/placeholder-intake";

test.afterEach(async ({ page }, testInfo) => {
  await discardIfStillOpen(page, testInfo);
});

test(
  "Placeholder pipeline (fast quad crop) — six cards on a scanner bed are cropped fast, no escalation, three pairs",
  { tag: ["@placeholders"] },
  async ({ page, signIn }) => {
    await signIn("/print/placeholders");
    await expect(page.getByRole("heading", { name: "Upload your cards" })).toBeVisible({ timeout: LAUNCH_GATE });

    await startPlaceholderBatch(page, placeholderScans("placeholder-fixtures"));

    await expect(page.getByText("All 6 photos read.")).toBeVisible();
    await expectAccessible(page, { label: "Placeholder upload, all read" });

    await finishPlaceholderBatch(page);
    await expectAccessible(page, { label: "Placeholder batch, pairs ready" });
  },
);
