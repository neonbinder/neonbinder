/**
 * The placeholder tool's real intake (`/print/placeholders`, NEO-529): the
 * helpers the four placeholder pipeline specs share. They used to enter through
 * a test-only seed page that fetched the fixtures and cancelled the account's
 * open batches; now they drop the committed scans on the real drop zone and
 * recover from the batch cap through the screen's own "Recent runs" list.
 *
 * Fixtures stay in `public/placeholder-fixtures{,-corner,-fullbleed}/`, each
 * with a `manifest.json` whose `files` lists the scans in upload order.
 *
 * ## Approved ceilings (GUIDE hard rule 3; Jason, 2026-11-13, NEO-529)
 * Everything else a placeholder spec waits for is the standard 7 s.
 *
 * - `UPLOAD_CEILING`, 18 s, from the drop to "Uploaded 6 of 6 images.". The run
 *   view appears only after the last photo is up (product decision, kept), and
 *   the six ~300 KB scans go up one after another through signed POSTs.
 *   Measured 4.1-10.6 s on the real drop zone (the old seed page landed in
 *   5.4-16.5 s). Voided by: a different photo count or size, or an upload path
 *   that sends the photos in parallel.
 * - `HEAVY_CEILING`, 80 s, from the escalating state to "Finish the batch" on
 *   the heavy path (six cornered scans past the fast crop). Measured 6.4-73.2 s
 *   over 7 green runs: the heavy service answers a warm call in 2.0-3.5 s and a
 *   cold one in 25.6-27.6 s. Voided by: a heavy service that cold-starts for
 *   longer than that, or more escalated photos than six.
 *
 * "All 6 photos read." on the FAST path is NOT given a ceiling: after the last
 * upload it is 7 s (measured about 6.5 s or less, so the headroom is thin). A
 * red there is a product finding, never a reason to raise it.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, expectAccessible, LAUNCH_GATE } from "./fixtures";
import { intakeDropzone } from "./collection";

/** Drop to "Uploaded N of N images." Approved 18 s, see the header. */
export const UPLOAD_CEILING = 18_000;
/** Escalating state to "Finish the batch", heavy path. Approved 80 s, see the header. */
export const HEAVY_CEILING = 80_000;

const PUBLIC_DIR = fileURLToPath(new URL("../../public/", import.meta.url));

/** The scans of a fixture set, as absolute paths in the order its manifest lists them. */
export function placeholderScans(set: string, opts: { backFirst?: boolean } = {}): string[] {
  const manifestPath = path.join(PUBLIC_DIR, set, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`placeholder fixture set "${set}" has no manifest at public/${set}/manifest.json`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { files?: unknown } | string[];
  const names = Array.isArray(manifest) ? manifest : manifest.files;
  if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === "string")) {
    throw new Error(`placeholder fixture set "${set}" lists no files in its manifest`);
  }
  const ordered = [...(names as string[])];
  if (opts.backFirst) {
    // 02,01,04,03,06,05: every card's back goes up before its front; an odd
    // trailing file keeps its place.
    for (let i = 0; i + 1 < ordered.length; i += 2) {
      [ordered[i], ordered[i + 1]] = [ordered[i + 1], ordered[i]];
    }
  }
  return ordered.map((name) => {
    const file = path.join(PUBLIC_DIR, set, name);
    if (!fs.existsSync(file)) throw new Error(`placeholder fixture "${set}" lists ${name} but the file is missing`);
    return file;
  });
}

function recentRuns(page: Page): Locator {
  return page.getByRole("region", { name: "Recent runs" });
}

const RUN_VIEW = (page: Page) => page.getByRole("heading", { name: "Your cards", exact: true });

/** Discard the batch the page is showing: button, confirm dialog, the page's own line. */
async function discardOpenBatch(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Discard this batch" }).click();
  const dialog = page.getByRole("dialog", { name: "Discard this batch?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Discard it" }).click();
  await expect(page.getByText("You discarded this batch.")).toBeVisible();
}

/**
 * Free the account's batch slots through the screen: for each row of "Recent
 * runs" that reads "running", open it, discard it, and step Back. Bounded: the
 * list shows at most eight runs.
 */
export async function discardRunningBatches(page: Page): Promise<void> {
  const region = recentRuns(page);
  await expect(region).toBeVisible();
  const running = region.getByRole("listitem").filter({ has: page.getByText("running", { exact: true }) });
  for (let i = 0; i < 8; i++) {
    if ((await running.count()) === 0) return;
    const row = running.first();
    const link = row.getByRole("link");
    const id = (await link.textContent()) ?? "";
    await link.click();
    await discardOpenBatch(page);
    await page.goBack();
    // Back on the list, and this run no longer reads "running".
    await expect(region).toBeVisible();
    await expect(region.getByRole("listitem").filter({ hasText: id }).getByText("running", { exact: true })).toBeHidden();
  }
  throw new Error("discardRunningBatches: still running batches after eight discards");
}

const CAP_ALERT = /Couldn't start a scan session — you already have \d+ active batches/;
const OTHER_REFUSAL = /Couldn't start a scan session|Couldn't upload these scans|Uploaded \d+ of \d+ images — /;

/**
 * Drop `files` on the real drop zone and end on the run view ("Your cards")
 * with "Uploaded N of N images.". The run view appears only after the last
 * photo is up, so the wait is `UPLOAD_CEILING`.
 *
 * The one refusal this recovers from is the active-batch cap ("you already have
 * N active batches"): the previous run's leftovers are discarded through
 * "Recent runs" and the files are dropped again. Any other refusal, the
 * 12-starts-an-hour rate limit included, fails by name.
 */
export async function startPlaceholderBatch(page: Page, files: string[]): Promise<void> {
  const uploaded = page.getByText(`Uploaded ${files.length} of ${files.length} images.`);
  const refusal = page.getByRole("alert").filter({ hasText: OTHER_REFUSAL });
  const dropzone = intakeDropzone(page);

  await dropzone.setInputFiles(files);
  await expect(uploaded.or(refusal)).toBeVisible({ timeout: UPLOAD_CEILING });

  if (await refusal.isVisible()) {
    const said = (await refusal.textContent()) ?? "";
    if (!CAP_ALERT.test(said)) throw new Error(`The placeholder batch was refused: ${said}`);
    await discardRunningBatches(page);
    await intakeDropzone(page).setInputFiles(files);
    await expect(uploaded.or(refusal)).toBeVisible({ timeout: UPLOAD_CEILING });
    if (await refusal.isVisible()) {
      throw new Error(`The placeholder batch was refused after discarding the running ones: ${await refusal.textContent()}`);
    }
  }
  await expect(uploaded).toBeVisible();
  await expect(RUN_VIEW(page)).toBeVisible();
}

/**
 * Close the batch from "Finish the batch": axe on the "Finish this batch?"
 * dialog, "Finish it", then "N pairs ready to print." (3 for the six-scan
 * fixtures).
 */
export async function finishPlaceholderBatch(page: Page, pairs = 3): Promise<void> {
  await page.getByRole("button", { name: "Finish the batch" }).click();
  const dialog = page.getByRole("dialog", { name: "Finish this batch?" });
  await expect(dialog).toBeVisible();
  await expectAccessible(page, { label: "Finish this batch dialog" });
  await dialog.getByRole("button", { name: "Finish it" }).click();
  await expect(page.getByText(`${pairs} pairs ready to print.`)).toBeVisible();
}

/**
 * A spec's `afterEach` tidy (R7): do not leave the batch the spec started
 * running, so the next spec on the worker does not meet the cap. It reopens
 * the run the spec's own page is on, on a SECOND page of the same signed-in
 * context, so the failure screenshot and `error-context.md` still show what
 * was on screen when the spec went red. It waits for the run to settle into
 * one of its two states (the "Discard this batch" button, or a finished or
 * stopped heading) and discards only in the first; a spec that finished its
 * batch has nothing to discard and only looks. A page with no run in its URL
 * started none that this can name, and the next `startPlaceholderBatch`
 * recovers from the cap itself. A tidy failure never masks the body's: when the
 * body failed it goes on the test's annotations, otherwise it is thrown.
 */
export async function discardIfStillOpen(page: Page, testInfo: TestInfo): Promise<void> {
  const jobId = new URL(page.url()).searchParams.get("jobId");
  if (!jobId) return;
  const bodyFailed = testInfo.status !== testInfo.expectedStatus;
  const tidy = await page.context().newPage();
  try {
    await tidy.goto(`/print/placeholders?jobId=${jobId}`);
    const discard = tidy.getByRole("button", { name: "Discard this batch" });
    const finished = tidy.getByRole("heading", { name: /^(Your cards are ready|This batch stopped)$/ });
    await expect(discard.or(finished)).toBeVisible({ timeout: LAUNCH_GATE });
    if (await discard.isVisible()) await discardOpenBatch(tidy);
  } catch (error) {
    if (!bodyFailed) throw error;
    testInfo.annotations.push({ type: "cleanup-failed", description: String(error) });
  } finally {
    await tidy.close();
  }
}
