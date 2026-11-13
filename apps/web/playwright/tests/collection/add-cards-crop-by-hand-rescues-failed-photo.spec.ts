// NEO-481 (R1): a photo the pipeline could not read is rescued by hand. Its
// loose tile offers "Crop by hand: <file>"; the viewer opens on the scan's
// original with no auto crop, the collector draws the box and saves, and the
// photo is read again, pairs with its other side and lands matched.
//
// The failure is seeded on a REAL upload (/testing/fail-placeholder-entry,
// `testing.failMyTestPlaceholderEntry`): preprocess always falls back to some
// crop, so no fixture fails by itself, and a 502 or a timeout cannot be made
// on cue. The hook does to the uploaded front what a 502 from /process-entry
// leaves: the photo is failed, its read is cleared, its pair dissolves, and its
// `extracted/` original stays in the bucket for the hand crop. Everything the
// spec asserts before the hook (the card read and matched) is the real
// pipeline's; everything after is the collector's path through the real
// render and re-read.
//
// PREVIEW ONLY, from the Save on: the render, the re-read, the pairing and the
// match need the PR's preprocess (/render-edit). A worktree deployment calls
// dev preprocess, so locally the spec runs to "Saved." and goes red at the
// rescue. The steps that need it are marked below.
//
// R7/R7a: writes only a hand-made, per-attempt set (`intkc-<ATTEMPT_TOKEN>`,
// SET-REGISTRY.md) under the real Baseball > 2024 > Topps, with no marketplace
// id beneath it: one hand-added card with the real player's name (what the
// scans read; scoped by the set). One intake run (closed with "Done adding
// photos") and the hand edit of its front. No copy is saved. Self-cleaning on
// any path (the finally).
//
// R5: the upload and the first read are the placeholder pipeline's exception
// (PIPELINE, as in add-cards-from-photos-real-scans); the rescue (render,
// re-read, re-pair, re-match) is EDIT_LANDS (support/photo-viewer.ts, Jason
// 2026-11-10). The hook hop is the launch gate. Every collector action and our
// own writes run at 7 s.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { addCardViaForm, escapeRe } from "../../support/cards";
import { intakeDropzone, pickIntakeSet } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { EDIT_LANDS } from "../../support/photo-viewer";
import { VARIANT_TYPES_SYNC, columnHeading, drillToCustom, selectOrCreate, setBuilderReady } from "../../support/set-builder";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "intake");
const FRONT = "01-mcfadden-front.jpg";
const BACK = "02-mcfadden-back.jpg";
/** The placeholder pipeline's exception: the same ceiling as add-cards-from-photos-real-scans (NEO-407). */
const PIPELINE = 480_000;

test(
  "Add cards: a photo that could not be read is cropped by hand on its original, read again, paired and matched",
  { tag: ["@collection"] },
  async ({ page, signIn, env }) => {
    const setName = `intkc-${env.ATTEMPT_TOKEN}`;
    const label = "#160 Darren McFadden";
    const doneButton = page.getByRole("button", { name: "Done adding photos" });
    const runClosedNote = page.getByText("This run's photos are all in. To add more, start a new run.");
    let doneClicked = false;
    let bodyPassed = false;
    let runUrl = "";

    try {
      // --- A set of our own, holding the one card ----------------------------------------------
      await signIn("/set-selector");
      await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });
      await drillToCustom(page, { sport: "Baseball", year: "2024", manufacturer: "Topps", set: setName });
      await selectOrCreate(page, "Variant Types", "Insert", { via: "list" });
      // 15 s is INHERITED, as is, from add-cards-from-photos-real-scans (NEO-382): the
      // Inserts column of a type this spec just made mounts behind the create. No
      // sign-off is recorded at either site (GUIDE hard rule 3); flagged in the
      // NEO-481 report for Jason to sign off or bring to 7 s, not granted here.
      await expect(columnHeading(page, "Inserts")).toBeVisible({ timeout: 15_000 });
      // A new type's column pays its first-visit sync before "+ Custom" shows (as in add-cards-from-photos-real-scans).
      await expect(page.getByRole("button", { name: "Add custom Inserts" })).toBeVisible({ timeout: VARIANT_TYPES_SYNC });
      await selectOrCreate(page, "Inserts", "Base", { via: "list" });
      await expect(page.getByRole("button", { name: "Open add card form" })).toBeVisible();
      await addCardViaForm(page, { cardNumber: "160", playerName: "Darren McFadden" });

      // --- The run: Main, this set's Base, the card's front and back, read and matched -------------
      await page.goto("/collection?tab=add");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
      await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });
      await pickIntakeSet(page, { sport: "Baseball", year: "2024", manufacturer: "Topps", set: setName }, { under: "Insert" });
      await intakeDropzone(page).setInputFiles([path.join(FIXTURES, FRONT), path.join(FIXTURES, BACK)]);
      await expect(page.getByRole("status").filter({ hasText: "Sent 2 photos." })).toBeVisible({ timeout: PIPELINE });
      await expect(page).toHaveURL(/[?&]run=/);
      runUrl = page.url();
      const runStatus = page.getByRole("status").filter({ hasText: /^(Working on your photos\.|Everything is read\..*|Done reading\..*|\d+ saved\..*)$/ });
      await expect(runStatus).toHaveText("Everything is read. 1 waiting for you, 0 saved.", { timeout: PIPELINE });
      const waiting = page.getByRole("region", { name: /^Needs you, \d+$/ });
      const pairing = page.getByRole("region", { name: /^Pairing, \d+$/ });
      const tile = waiting.getByRole("article", { name: label, exact: true });
      await expect(tile.getByText(/^Matched \d+%$/)).toBeVisible();

      // --- The front fails, as a 502 from the reader leaves it ------------------------------------
      // The hook takes this account's newest batch (this run's) and lands back on the run.
      await page.goto(`/testing/fail-placeholder-entry?file=${encodeURIComponent(FRONT)}`);
      const cropOnTile = pairing.getByRole("button", { name: `Crop by hand: ${FRONT}`, exact: true });
      // The launch gate: the hop's page load, its write and the run screen's first load.
      await expect(cropOnTile).toBeVisible({ timeout: LAUNCH_GATE });
      await expect(page).toHaveURL(runUrl);
      // Failed, and says so: the reason is the button's description and the tile's words.
      await expect(cropOnTile).toHaveAccessibleDescription("Couldn't read it");
      await expect(pairing.getByText("Couldn't read it", { exact: true })).toBeVisible();
      await expect(pairing.getByRole("button", { name: `Try again: ${FRONT}`, exact: true })).toBeVisible();
      // Its pair is gone: the card left Needs you, the back waits loose.
      await expect(waiting).toHaveAccessibleName("Needs you, 0");
      await expect(tile).toHaveCount(0);
      await expect(pairing).toHaveAccessibleName("Pairing, 2");
      await expectAccessible(page, { label: "Add cards, a photo that couldn't be read, with Crop by hand" });

      // --- Crop by hand: the scan's original, no auto crop to start from ---------------------------
      await cropOnTile.click();
      const viewer = page.getByRole("dialog", { name: `Front of ${FRONT}`, exact: true });
      await expect(viewer).toBeVisible();
      const tools = viewer.getByRole("toolbar", { name: "Photo tools" });
      const cropTool = tools.getByRole("button", { name: "Crop by hand", exact: true });
      // The viewer has two live lines once cropping (GUIDE: duplicated live regions),
      // so a line is found by what it says.
      const said = (words: string) => viewer.getByRole("status").filter({ hasText: new RegExp(`^${escapeRe(words)}$`) });
      await cropTool.click();
      await expect(cropTool).toHaveAttribute("aria-pressed", "true");
      const cropBox = viewer.getByRole("application", { name: "Crop box", exact: true });
      await expect(cropBox).toBeVisible();
      // The failure cleared the photo's auto crop: the box starts on the whole frame.
      await expect(viewer.getByText("No auto crop here. Drag the box to fit the card.", { exact: true })).toBeVisible();
      // Bring the box in off the frame's edges, by keys (it reads itself out once it holds still).
      await cropBox.focus();
      for (let i = 0; i < 3; i++) await page.keyboard.press("-");
      const readout = viewer.getByText(/^Tilted -?\d+°, \d+ by \d+ pixels, \d+% from the left and \d+% from the top\.$/);
      await expect(readout).toHaveText(/^Tilted 0°, \d+ by \d+ pixels, [1-9]\d*% from the left/);
      await expectAccessible(page, { within: viewer, label: "Card photo viewer, cropping a photo that couldn't be read" });
      await viewer.getByRole("button", { name: "Save photo", exact: true }).click();
      // Our own write (7 s): accepted at once.
      await expect(said("Saved.")).toBeVisible();
      await viewer.getByRole("button", { name: "Close", exact: true }).click();
      await expect(viewer).toBeHidden();

      // --- PREVIEW ONLY: read again, paired, matched -------------------------------------------------
      // The render lands (EDIT_LANDS), the photo is read again and is no longer
      // failed: its Crop by hand, Try again and reason leave the pile with it.
      await expect(cropOnTile).toHaveCount(0, { timeout: EDIT_LANDS });
      await expect(pairing.getByRole("button", { name: `Try again: ${FRONT}`, exact: true })).toHaveCount(0);
      await expect(pairing.getByText("Couldn't read it", { exact: true })).toHaveCount(0);
      // It pairs with its back again and the card is matched, on the new read.
      await expect(runStatus).toHaveText("Everything is read. 1 waiting for you, 0 saved.", { timeout: EDIT_LANDS });
      await expect(pairing).toHaveAccessibleName("Pairing, 0");
      await expect(waiting).toHaveAccessibleName("Needs you, 1");
      await expect(tile.getByText(/^Read: #160 · .*mcfadden/i)).toBeVisible();
      await expect(tile.getByText(/^Matched \d+%$/)).toBeVisible();
      // Rescued, not a failed edit: no "Keep the old photo" offer on the card.
      await expect(tile.getByRole("button", { name: `Keep the old photo: the front of ${label}`, exact: true })).toHaveCount(0);
      await expectAccessible(page, { label: "Add cards, a photo rescued by a hand crop, matched" });

      await doneButton.click();
      doneClicked = true;
      await expect(runClosedNote).toBeVisible();
      bodyPassed = true;
    } finally {
      // Self-cleaning on any path (R7): close the run. A failure is thrown only
      // when the body passed, else noted (the body's own failure is the one to read).
      // A run that started but never said "Sent" still holds one of the two run slots.
      const openRun = runUrl || (/[?&]run=/.test(page.url()) ? page.url() : "");
      if (!doneClicked && openRun) {
        try {
          // A fresh load: an open viewer would leave the page behind it inert.
          await page.goto(openRun);
          await doneButton.click();
          await expect(runClosedNote).toBeVisible();
        } catch (e) {
          if (bodyPassed) throw e;
          test.info().annotations.push({ type: "cleanup-failed", description: String(e) });
        }
      }
    }
  },
);
