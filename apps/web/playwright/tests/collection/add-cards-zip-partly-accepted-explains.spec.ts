// NEO-446 (R1): Add cards explains a zip that only partly made it in. A zip with
// one card photo and one photo over the 64 megapixel limit does not fail: the
// photo that was fine is read into the lanes, and one warning line beside them
// says how many made it, which one did not (its file name, set apart as its own
// piece of text) and why, with "Start a new run" for the rest. The photo that
// made it in is a lone card side, so it can be set aside from the Pairing pile
// (by keyboard), which leaves the run clear and finished, listed under Set aside
// in the Saved lane, and brought back from there into Pairing.
//
// The `d` shortcut sets a matched CARD aside (a tile in Needs you); a loose photo
// has no key, so the keyboard proof is the button itself: focused, then Enter.
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
// R5: every wait is the normal 7 s (NEO-446: measured on a warm dev service, upload
// 0.8-1.3 s, extract 0.3-0.8 s, read 2.8 s). The preprocess legs are wrapped in
// `test.step`, so the report carries each leg's own duration; a red on a cold CI
// instance comes back to the owner with that number, never a longer timeout.
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
  "one-photo-one-too-big.zip",
);

/** The photo that made it in: how every control names it. */
const PHOTO = "01-bowe-front.jpg";

/** `runNotice` for a zip with 1 photo in and 1 over the limit, named (`someRejectedLine`). */
const PARTLY =
  '1 photo made it in. 1 didn\'t: "02-flat-67mp.jpg" is too big (over 64 megapixels or 32 MB). Shrink it and drop it in a new run, with its other side.';

test(
  "Add cards: a zip where one photo is over the limit reads the other into the lanes and names the one that did not make it, and sets the other aside and back",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    await signIn("/collection?tab=add");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });

    // --- Drop the zip: the run starts and lands on the URL ----------------------
    await test.step("upload: zip dropped to ?run= in the URL", async () => {
      await page.getByLabel("Drag your card photos here, or browse your files").setInputFiles(ZIP);
      await expect(page).toHaveURL(/[?&]run=/);
    });

    // --- The line: how many made it, which one did not, and why ------------------
    const line = page.getByRole("status").filter({ hasText: PARTLY });

    // Extract turns the big photo away and registers the other.
    await test.step("extract: ?run= to the partly-accepted line", async () => {
      await expect(line).toHaveText(PARTLY);
    });

    // The file name stands as a piece of text of its own (the `<bdi>`, see the header).
    await expect(line.getByText('"02-flat-67mp.jpg"', { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start a new run", exact: true })).toBeVisible();

    // --- The lanes are still there: the photo that made it in is read and waiting ---
    // A lone card side never pairs, so it ends in Pairing, read and waiting.
    const pairing = (n: number) => page.getByRole("region", { name: `Pairing, ${n}`, exact: true });

    await test.step("read: the one photo read and waiting in Pairing", async () => {
      await expect(pairing(1)).toBeVisible();
    });

    await expect(page.getByRole("region", { name: "Cropping & reading, 0", exact: true })).toBeVisible();
    const saved = page.getByRole("region", { name: /^Saved, \d+$/ });
    await expect(saved).toHaveAccessibleName("Saved, 0");
    // Not the failure wording: the zip did not fail.
    await expect(page.getByText(/^Nothing in that zip made it in/)).toHaveCount(0);
    await expect(page.getByText("This run's photos are all in")).toHaveCount(0);
    // Settled (nothing arriving): the whole screen, the warning line beside the lanes.
    await expectAccessible(page, { label: "Add cards, a zip that partly made it in" });

    // --- Set aside, by keyboard: the run reads as finished ---------------------------
    // `exact`: "Set aside" is also the heading of the list it lands in.
    const setAside = pairing(1).getByRole("button", { name: `Set aside ${PHOTO}`, exact: true });
    await setAside.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: `Set aside ${PHOTO}.` })).toBeVisible();
    await expect(pairing(0)).toBeVisible();
    // Every column but Saved is clear: nothing reading, pairing, matching or waiting.
    for (const column of ["Cropping & reading", "Pairing", "Matching", "Needs you"]) {
      await expect(page.getByRole("region", { name: `${column}, 0`, exact: true })).toBeVisible();
    }
    // The photo is listed at the bottom of the Saved lane, with a way back; the
    // lane's count is of saved cards, so it stays 0.
    await expect(saved).toHaveAccessibleName("Saved, 0");
    await expect(saved.getByRole("heading", { name: "Set aside", exact: true })).toBeVisible();
    const bringBack = saved.getByRole("button", { name: `Bring back ${PHOTO}`, exact: true });
    await expect(bringBack).toBeVisible();
    await expect(pairing(0).getByRole("button", { name: `Set aside ${PHOTO}`, exact: true })).toHaveCount(0);
    await expectAccessible(page, { label: "Add cards, a photo set aside from a partly accepted zip" });

    // --- Brought back: it returns to Pairing ---------------------------------------------
    await bringBack.click();
    await expect(page.getByRole("status").filter({ hasText: `Brought back ${PHOTO}.` })).toBeVisible();
    await expect(pairing(1)).toBeVisible();
    await expect(pairing(1).getByRole("button", { name: `Set aside ${PHOTO}`, exact: true })).toBeVisible();
    await expect(saved.getByRole("heading", { name: "Set aside", exact: true })).toHaveCount(0);
    await expectAccessible(page, { label: "Add cards, the photo brought back into Pairing" });
  },
);
