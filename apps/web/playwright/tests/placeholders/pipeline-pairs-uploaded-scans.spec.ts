// Origin: .maestro/flows/placeholders/pipeline-pairs-uploaded-scans.yaml (Maestro suite retired in NEO-341; see git history)
// NEO-175 / NEO-327: six frame-filling scans, uploaded BACK-FIRST through the
// real signed-POST path, process on the fast path, and pair front-side-up
// whatever order they arrived in. The 180 s ceiling is what proves the fast
// path (six heavy escalations cannot settle inside it).
import { test, expect } from "../../support/fixtures";

test(
  "Placeholder pipeline (fast path) — six frame-filling scans process fast and pair front-side-up whatever order they arrive in",
  { tag: ["@placeholders"] },
  async ({ page, signIn }) => {
    // The seed page pushes the committed fixtures through the real upload path
    // (signed POST to GCS, ~300 KB each) then forwards to the run view.
    await signIn(
      "/testing/seed-placeholder-upload%3Ffixtures%3Dplaceholder-fixtures-fullbleed%26order%3Dback-first",
    );
    await expect(page.getByText("Upload your cards")).toBeVisible({ timeout: 90_000 });

    // A real six-image session exists, and every one settles on the fast path.
    await expect(page.getByRole("heading", { name: "Your cards", exact: true })).toBeVisible();
    await expect(page.getByText("All 6 photos read.")).toBeVisible({ timeout: 180_000 });

    // Close the batch so the FINAL pairing run records the count.
    await page.getByRole("button", { name: "Finish the batch" }).click();
    await expect(page.getByText("Finish this batch?")).toBeVisible();
    await page.getByRole("button", { name: "Finish it" }).click();

    // 3 pairs x 2 = all six accounted for; none failed, none left over.
    await expect(page.getByText("3 pairs ready to print.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Check the pairs" })).toBeVisible();

    // Every pair is FRONT-SIDE-UP although each back arrived first.
    await expect(page.getByText("Front · 01-vorkle-front.jpg")).toBeVisible();
    await expect(page.getByText("Back · 02-vorkle-back.jpg")).toBeVisible();
    await expect(page.getByText("Front · 03-quillden-front.jpg")).toBeVisible();
    await expect(page.getByText("Front · 05-mossbaum-front.jpg")).toBeVisible();

    // NEO-315: the crops can be shown back (the signed-read mint answers).
    await expect(page.getByText(/Loading image/)).toHaveCount(0);
    await expect(page.getByText("Image unavailable")).toHaveCount(0);
  },
);
