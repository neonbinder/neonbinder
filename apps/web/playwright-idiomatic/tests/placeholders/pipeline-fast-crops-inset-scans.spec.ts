// Spec: .maestro/flows/placeholders/pipeline-fast-crops-inset-scans.yaml
// Cards centred on a scanner bed are cropped by the fast quad stage: no
// escalation, three pairs.
import { test, expect } from "../../support/fixtures";

test(
  "Placeholder pipeline (fast quad crop) — six cards on a scanner bed are cropped fast, no escalation, three pairs",
  { tag: ["@placeholders"] },
  async ({ page, signIn }) => {
    await signIn("/testing/seed-placeholder-upload%3Ffixtures%3Dplaceholder-fixtures");
    await expect(page.getByText("Upload your cards")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText("Your cards", { exact: true })).toBeVisible();

    await expect(page.getByText("All 6 photos read.")).toBeVisible({ timeout: 60_000 });

    await page.getByRole("button", { name: "Finish the batch" }).click();
    await expect(page.getByText("Finish this batch?")).toBeVisible();
    await page.getByRole("button", { name: "Finish it" }).click();
    await expect(page.getByText("3 pairs ready to print.")).toBeVisible();
  },
);
