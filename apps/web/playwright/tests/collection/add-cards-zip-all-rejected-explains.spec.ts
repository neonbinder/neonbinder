// NEO-446 (R1): Add cards explains a failed run. A zip in which nothing can be
// used (two 67 MP photos, over the 64 MP limit, and a notes.txt that is no
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
// R7: writes only the account's own failed run (nothing is saved, no set or card
// is touched). A failed run holds no active-batch slot.
//
// R5: the one wait past 7 s is the pipeline's own exception, the ceiling
// pipeline-pairs-uploaded-scans uses for fast-path work on the preprocess service
// (180 s: the zip's upload, the service's extract and the pairing run that
// closes the job; a cold fast instance included). Everything a collector does
// runs at 7 s.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const ZIP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "intake",
  "zip",
  "over-64mp-and-a-note.zip",
);
/** The preprocess pipeline's fast-path ceiling (see the header). */
const PIPELINE = 180_000;

/** `runNotice` for a failed zip with 2 photos over 64 MP and 1 non-photo, nothing in. */
const FAILURE =
  "Nothing in that zip made it in: 2 are too big (over 64 MP); 1 isn't a JPEG, PNG or WebP. Fix them, zip them up again, and start a new run.";

test(
  "Add cards: a zip with nothing usable in it ends the run with a line saying why, and Start a new run leaves it",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    await signIn("/collection?tab=add");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });

    // --- Drop the zip: the run starts and lands on the URL ----------------------
    const dropzone = page.getByLabel("Drag your card photos here, or browse your files");
    await dropzone.setInputFiles(ZIP);
    // Sending the archive is the pipeline's upload leg: its exception.
    await expect(page).toHaveURL(/[?&]run=/, { timeout: PIPELINE });
    const runUrl = page.url();

    // --- The run fails, and the screen says why ---------------------------------
    const failure = page.getByRole("status").filter({ hasText: FAILURE });
    // Extract turns every entry away, then the closing pairing run fails the
    // job: the pipeline's exception again.
    await expect(failure).toHaveText(FAILURE, { timeout: PIPELINE });
    await expect(page.getByRole("button", { name: "Start a new run", exact: true })).toBeVisible();
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
