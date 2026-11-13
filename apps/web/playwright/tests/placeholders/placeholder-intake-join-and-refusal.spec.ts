// R1 (NEO-529): the placeholder intake's two drop rules a user meets on
// /print/placeholders. (a) Scans dropped on a batch that is still open join it:
// same run, same address, eight photos, still one running batch. (b) A drop
// refused by the active-batch cap says so and the tray does not claim the photos
// were sent.
//
// Not proved here, and why (coverage audit, NEO-529): the closed-batch re-send
// ("That batch was already finished, so these started a new one", and the
// partial "X of Y got in" notice). The page follows its run live, so a batch
// finished from a second tab stops reading "collecting" on the first within
// milliseconds, and a drop then simply starts a new batch with no notice. The
// notices exist only for a drop that lands in the gap between the server closing
// the batch and the page hearing of it, which no user path can hold open and
// which a spec could only fake by feeding the page a stale run over Convex's
// socket (a fault hook the suite does not grant here). They stay unit-proven:
// `intake.test.tsx` (re-send, partial, and the fresh-batch cases) and
// `lib/placeholders/upload-run.test.ts` (the send stops at BATCH_NOT_COLLECTING).
//
// Self-cleaning (R7): `afterEach` discards every running batch the spec started,
// on a second page, whichever page started them.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { intakeDropzone } from "../../support/collection";
import {
  discardIfStillOpen,
  discardRunningBatches,
  placeholderScans,
  startPlaceholderBatch,
} from "../../support/placeholder-intake";

test.afterEach(async ({ page }, testInfo) => {
  await discardIfStillOpen(page, testInfo, { all: true });
});

test(
  "Placeholder intake — more scans dropped on an open batch join it, and a drop refused by the batch cap leaves no 'sent' line",
  { tag: ["@placeholders"] },
  async ({ page, signIn }) => {
    await signIn("/print/placeholders");
    await expect(page.getByRole("heading", { name: "Upload your cards" })).toBeVisible({ timeout: LAUNCH_GATE });
    const scans = placeholderScans("placeholder-fixtures");

    // --- (a) A drop on the open batch joins it ------------------------------
    await startPlaceholderBatch(page, scans);
    // The run is open ("Discard this batch" is offered only while it can take
    // more), so the next drop is an add, not a new batch.
    await expect(page.getByRole("button", { name: "Discard this batch" })).toBeVisible();
    const runUrl = page.url();
    const recent = page.getByRole("region", { name: "Recent runs" });
    const running = recent.getByText("running", { exact: true });
    await expect(running).toHaveCount(1);

    await intakeDropzone(page).setInputFiles(scans.slice(0, 2));
    await expect(page.getByText("Uploaded 2 of 2 images.")).toBeVisible();
    await expect(page).toHaveURL(runUrl);
    // The run holds eight photos now, six plus the two that joined.
    await expect(page.getByText(/^(Reading your cards — \d+ of 8 done\.|All 8 photos read\.)$/)).toBeVisible();
    await expect(running).toHaveCount(1);
    await expectAccessible(page, { label: "Placeholder run, two more scans joined" });

    // --- (b) The cap refuses a drop, and the tray does not say "sent" -------
    // A second batch from a page with no run in its address: two are running.
    const second = await page.context().newPage();
    try {
      await second.goto("/print/placeholders");
      await expect(second.getByRole("heading", { name: "Upload your cards" })).toBeVisible();
      await startPlaceholderBatch(second, scans);
      await second.goto("/print/placeholders");
      await expect(second.getByRole("heading", { name: "Upload your cards" })).toBeVisible();
      await expect(second.getByRole("region", { name: "Recent runs" }).getByText("running", { exact: true })).toHaveCount(2);

      await intakeDropzone(second).setInputFiles(scans);
      await expect(
        second.getByRole("alert").filter({ hasText: /you already have \d+ active batches/ }),
      ).toBeVisible();
      // Nothing went up, so the tray makes no claim that it did (the refusal
      // above is the positive; its tray line is quiet while an error stands).
      await expect(second.getByText(/photos? sent\./)).toHaveCount(0);
      await expectAccessible(second, { label: "Placeholder intake, start refused by the batch cap" });

      // Free the slots through the screen; the first page's run is among them.
      await discardRunningBatches(second);
    } finally {
      await second.close();
    }
  },
);
