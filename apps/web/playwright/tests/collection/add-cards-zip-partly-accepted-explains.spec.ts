// NEO-446 (R1): Add cards explains a zip that only partly made it in. A zip with
// one card photo and one photo over the 64 megapixel limit does not fail: the
// photo that was fine is read into the lanes, and one warning line beside them
// says how many made it, which one did not (its file name, set apart as its own
// piece of text) and why, with "Start a new run" for the rest.
//
// Fixture: `fixtures/intake/zip/one-photo-one-too-big.zip` (README beside it has
// the generation commands): `01-bowe-front.jpg`, an ordinary card photo, and
// `02-flat-67mp.jpg`, a flat 8200x8200 JPEG (67.24 MP, 395 KB), stored with
// `zip -0`. 67 MP is over the limit on the old 50 MP service and the new 65 MP
// one alike, so this spec does not depend on which preprocess build the
// deployment points at. One card side is a loose photo and never pairs, so none
// of the assertions depends on pairing or on what is read: the line is the job
// row's, the lanes are the run's.
//
// The quoted file name: the product draws it in its own `<bdi>` element so a
// right-to-left name cannot reorder the sentence. A test may not reach for a tag,
// so it is asserted as a piece of text of its own: `getByText(name, { exact: true })`
// matches an element whose whole text is the quoted name, which the sentence's
// paragraph is not.
//
// R7: writes only the account's own run (nothing is saved, no set or card is
// touched). The run is a finished one (the zip's job is not an open upload
// session), so it holds no active-batch slot.
//
// R5: the waits past 7 s are the pipeline's own exception (support/pipeline-wait.ts):
// the zip's upload, the service's extract and the one photo's read. Everything a
// collector does runs at 7 s.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { PIPELINE, measuredWait } from "../../support/pipeline-wait";

const ZIP = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "intake",
  "zip",
  "one-photo-one-too-big.zip",
);

/** `runNotice` for a zip with 1 photo in and 1 over the limit, named (`someRejectedLine`). */
const PARTLY =
  '1 photo made it in. 1 didn\'t: "02-flat-67mp.jpg" is too big (over 64 megapixels or 32 MB). Shrink it and drop it in a new run, with its other side.';

test(
  "Add cards: a zip where one photo is over the limit reads the other into the lanes and names the one that did not make it",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    await signIn("/collection?tab=add");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });

    // --- Drop the zip: the run starts and lands on the URL ----------------------
    const dropped = Date.now();
    await page.getByLabel("Drag your card photos here, or browse your files").setInputFiles(ZIP);
    // Sending the archive is the pipeline's upload leg: its exception.
    await expect(page).toHaveURL(/[?&]run=/, { timeout: PIPELINE });
    const uploaded = Date.now();
    measuredWait("upload: zip dropped to ?run= in the URL", dropped);

    // --- The line: how many made it, which one did not, and why ------------------
    const line = page.getByRole("status").filter({ hasText: PARTLY });
    // Extract turns the big photo away and registers the other: the pipeline's exception.
    await expect(line).toHaveText(PARTLY, { timeout: PIPELINE });
    measuredWait("extract: ?run= to the partly-accepted line", uploaded);
    // The file name stands as a piece of text of its own (the `<bdi>`, see the header).
    await expect(line.getByText('"02-flat-67mp.jpg"', { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start a new run", exact: true })).toBeVisible();

    // --- The lanes are still there: the photo that made it in is being read ------
    // A lone card side never pairs, so it ends in Pairing, read and waiting (the
    // lanes are the run's: a closed-out count, not a failure's empty row).
    const read = Date.now();
    await expect(page.getByRole("region", { name: "Pairing, 1" })).toBeVisible({ timeout: PIPELINE });
    measuredWait("read: line shown to the one photo read and waiting in Pairing", read);
    await expect(page.getByRole("region", { name: "Cropping & reading, 0" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Saved, 0" })).toBeVisible();
    // Not the failure wording: the zip did not fail.
    await expect(page.getByText(/^Nothing in that zip made it in/)).toHaveCount(0);
    await expect(page.getByText("This run's photos are all in")).toHaveCount(0);
    // Settled (nothing arriving): the whole screen, the warning line beside the lanes.
    await expectAccessible(page, { label: "Add cards, a zip that partly made it in" });
  },
);
