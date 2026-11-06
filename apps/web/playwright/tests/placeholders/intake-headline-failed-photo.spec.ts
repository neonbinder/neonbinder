// NEO-440: when photos fail, the placeholder intake headline says so. It used to
// print "All N photos read." as soon as every photo had settled, failed ones
// included, with "couldn't be read" further down the page.
//
// The failed photo is seeded (/testing/seed-placeholder-run?failedPhoto=1,
// `seedMyTestFailedPhotoRun`), as in add-cards-failed-photo-try-again: making a
// real photo fail on cue would cost minutes of model time and could not be made
// certain. The partial wording ("4 of 6 photos read") is covered by unit tests.
//
// R7: writes only the account's own batch (the seed cancels the account's open
// batches first, for the active-run cap). Self-cleaning: the batch is discarded
// at the end.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Placeholder intake: a batch whose photo failed says it couldn't be read, not that all were read",
  { tag: ["@placeholders"] },
  async ({ page, signIn }) => {
    await signIn("/testing/seed-placeholder-run%3FfailedPhoto%3D1%26view%3Dplaceholders");

    await expect(page.getByText("Couldn't read your photo.")).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(page.getByText(/^All \d+ photos? read\.$/)).toHaveCount(0);
    // The batch is still the collector's to finish or discard, and the list
    // that names the failed photo is still there.
    await expect(page.getByRole("button", { name: "Finish the batch" })).toBeVisible();
    await expect(page.getByText("1 photo couldn't be read")).toBeVisible();
    await expectAccessible(page, { label: "Placeholder batch, a photo that couldn't be read" });

    await page.getByRole("button", { name: "Discard this batch" }).click();
    await expect(page.getByText("Discard this batch?")).toBeVisible();
    await expectAccessible(page, { label: "Discard this batch dialog" });
    await page.getByRole("button", { name: "Discard it" }).click();
    await expect(page.getByText("You discarded this batch.")).toBeVisible();
  },
);
