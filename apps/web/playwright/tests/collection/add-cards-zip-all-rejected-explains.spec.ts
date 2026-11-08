// NEO-446 (R1): Add cards explains a failed run. A zip in which nothing can be
// used (two 67 MP photos, over the 64 megapixel limit, and a notes.txt that is no
// photo) ends the run as failed, and the screen says why in the collector's
// words instead of "This run's photos are all in": one line naming what was
// turned away, no lanes (nothing reached them, a row of zeros would be false),
// and a "Start a new run" button. The line comes from the job row alone, so a
// reload on `?run=` says the same; "Start a new run" leaves the run (the URL
// drops `?run=`, the drop zone is the next thing focused) and Back returns to it.
//
// The line is mixed on purpose: notes.txt is a second kind of problem next to
// the two photos, so the wording is the "more than one kind" one in `runNotice`
// (apps/web/app/collection/final/intake/realLanes.ts), counts and no names.
//
// Fixture: `fixtures/intake/zip/over-64mp-and-a-note.zip` (README beside it
// has the generation commands): two flat 8200x8200 JPEGs (67.24 MP, under
// 400 KB each, so the zip's 100:1 expansion guard never applies) and notes.txt,
// stored with `zip -0`. 67 MP is over the limit on the old 50 MP service and
// the new 65 MP one alike, so this spec does not depend on which preprocess
// build the deployment points at.
//
// Mobile: the "Start a new run" button is at least 44 px tall (a touch target), the
// one branch, on `isMobile`; desktop has no such minimum.
//
// NEO-452: a drop waits in the browser until the run has a set, so the run is set
// up first (Main, then the seed's 2024 Topps Chrome Base through `pickIntakeSet`)
// and the zip then goes up at once. Nothing in it reaches Matching, so the set is
// only the run's home, never read against.
//
// R7/R7a: reads the seed's 2024 Topps Chrome Base only to pick it as the run's set
// (SET-REGISTRY.md, read-only consumers) and writes only the account's own failed
// run (nothing is saved, no set or card is touched). A failed run holds no
// active-batch slot.
//
// R3: the set pick and the drop zone through `support/collection.ts`.
//
// R5 (hard rule 3): every wait is the normal 7 s except ONE, the failure line after the
// extract (`COLD_EXTRACT`, below), which carries a signed-off ceiling. NEO-446 measured
// on a warm dev service: upload 0.8-1.3 s, extract 0.3-0.8 s, refusal 0.8 s, read 2.8 s.
// The preprocess legs are wrapped in `test.step`, so the report carries each leg's own
// duration.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { intakeDropzone, pickIntakeSet } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

/**
 * The one signed-off ceiling in this spec (GUIDE hard rule 3): 45 s, Jason, 2026-11-08, NEO-475.
 * It covers ONLY the wait for the failure line after the extract.
 * Measured: the FAST preprocess service's cold start took 8.5-24.2 s in CI (runs
 * 42524934716 and 42493262194) and 26.6 s locally against dev, against 0.33-0.97 s for
 * a warm extract. The Add cards
 * mount already warms FAST, but this spec drops the zip about 5-6 s after the mount,
 * so the service is still cold. It is void if a cold start is ever measured over 45 s,
 * and never a licence for any other wait in this spec.
 */
const COLD_EXTRACT = 45_000;

const ZIP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "intake",
  "zip",
  "over-64mp-and-a-note.zip",
);

/** `runNotice` for a failed zip with 2 photos over 64 megapixels (the zip wording adds "or 32 MB") and 1 non-photo, nothing in. */
const FAILURE =
  "Nothing in that zip made it in: 2 are too big (over 64 megapixels or 32 MB); 1 isn't a JPEG or PNG. Fix them, zip them up again, and start a new run.";

test(
  "Add cards: a zip with nothing usable in it ends the run with a line saying why, and Start a new run leaves it",
  { tag: ["@collection"] },
  async ({ page, signIn, isMobile }) => {
    await signIn("/collection?tab=add");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });
    // NEO-452: the run needs its set before a drop goes up.
    await pickIntakeSet(page);

    // --- Drop the zip: the run starts and lands on the URL ----------------------
    const dropzone = intakeDropzone(page);

    await test.step("upload: zip dropped to ?run= in the URL", async () => {
      await dropzone.setInputFiles(ZIP);
      await expect(page).toHaveURL(/[?&]run=/);
    });

    const runUrl = page.url();

    // --- The run fails, and the screen says why ---------------------------------
    const failure = page.getByRole("status").filter({ hasText: FAILURE });

    // Extract turns every entry away, then the closing pairing run fails the job.
    await test.step("extract: ?run= to the failure line (extract, closing pairing run)", async () => {
      await expect(failure).toHaveText(FAILURE, { timeout: COLD_EXTRACT });
    });

    const startNewRun = page.getByRole("button", { name: "Start a new run", exact: true });
    await expect(startNewRun).toBeVisible();
    // Mobile only, where the layout differs (the button is `max-sm:min-h-11`): a
    // thumb target of at least 44 px. The button is on screen (above), so one read
    // of its box is the user's size, not a poll.
    if (isMobile) {
      const box = await startNewRun.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    // Not the success line, not the loose-photo "Sent" line, and no lanes: nothing
    // reached them. (Positive assertions above: the failure line is on screen.)
    await expect(page.getByText("This run's photos are all in")).toHaveCount(0);
    await expect(page.getByRole("status").filter({ hasText: /^Sent / })).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: /^(Cropping & reading|Pairing|Matching|Needs you|Saved), \d+$/ }),
    ).toHaveCount(0);
    await expectAccessible(page, { label: "Add cards, a zip nothing in it could be used" });

    // --- A reload keeps it: the line is the job's, not the page's ----------------
    await page.reload();
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    // A fresh launch (R4): the job row loads under the launch gate.
    await expect(failure).toHaveText(FAILURE, { timeout: LAUNCH_GATE });
    await expect(page).toHaveURL(runUrl);
    await expect(page.getByText("This run's photos are all in")).toHaveCount(0);

    // --- Start a new run: off the failed run, ready for the next drop -------------
    // `exact`: the setup bar's "New run" button is a substring of this name.
    await page.getByRole("button", { name: "Start a new run", exact: true }).click();
    await expect(page).not.toHaveURL(/[?&]run=/);
    await expect(dropzone).toBeVisible();
    await expect(dropzone).toBeFocused();
    await expect(failure).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start a new run", exact: true })).toHaveCount(0);

    // --- Back is a step in the URL: the failed run is there again ------------------
    await page.goBack();
    await expect(page).toHaveURL(runUrl);
    await expect(failure).toHaveText(FAILURE);
    await expect(page.getByRole("button", { name: "Start a new run", exact: true })).toBeVisible();
  },
);
