// Origin: .maestro/flows/placeholders/pipeline-pairs-uploaded-scans.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-175 / NEO-327 / NEO-529: six frame-filling scans, dropped BACK-FIRST on
// the real /print/placeholders drop zone (one setInputFiles call keeps the
// order, so each back goes up before its front), process on the fast path and
// pair front-side-up whatever order they arrived in. The 7 s after the last
// upload to "All 6 photos read." is what proves the fast path (six heavy
// escalations cannot settle inside it).
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
  "Placeholder pipeline (fast path) — six frame-filling scans process fast and pair front-side-up whatever order they arrive in",
  { tag: ["@placeholders"] },
  async ({ page, signIn }) => {
    await signIn("/print/placeholders");
    await expect(page.getByRole("heading", { name: "Upload your cards" })).toBeVisible({ timeout: LAUNCH_GATE });

    // A real six-image session exists (signed POST to GCS for each), and every
    // one settles on the fast path.
    await startPlaceholderBatch(page, placeholderScans("placeholder-fixtures-fullbleed", { backFirst: true }));
    await expect(page.getByText("All 6 photos read.")).toBeVisible();

    // Close the batch so the FINAL pairing run records the count. 3 pairs x 2 =
    // all six accounted for; none failed, none left over.
    await finishPlaceholderBatch(page);
    await expect(page.getByRole("heading", { name: "Check the pairs" })).toBeVisible();

    // Every pair is FRONT-SIDE-UP although each back arrived first.
    await expect(page.getByText("Front · 01-vorkle-front.jpg")).toBeVisible();
    await expect(page.getByText("Back · 02-vorkle-back.jpg")).toBeVisible();
    await expect(page.getByText("Front · 03-quillden-front.jpg")).toBeVisible();
    await expect(page.getByText("Front · 05-mossbaum-front.jpg")).toBeVisible();

    // NEO-315: the crops can be shown back (the signed-read mint answers).
    await expect(page.getByText(/Loading image/)).toHaveCount(0);
    await expect(page.getByText("Image unavailable")).toHaveCount(0);
    await expectAccessible(page, { label: "Check the pairs" });
  },
);
