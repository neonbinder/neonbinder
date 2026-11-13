// NEO-481 (R1): a scan waiting in Add cards is cropped by hand on its ORIGINAL
// (the full scan, not the auto crop) in the card photo viewer: the box is
// tilted and the photo turned, Save is accepted at once and the tile says
// "Touching it up…" while the new crop renders and is read again; the card then
// lands back in Needs you, matched. Saving the card carries the edit to the
// copy: the drawer's photo is the edited one (landscape, from the turn). From
// its Saved tile the saved photo opens on the scan's original again (it is
// still there, so no "can only trim" line), a turn back is saved, and the
// drawer follows (portrait).
//
// Proof by the file: the drawer's photo is read off the address the browser
// downloads (`servedPhotoSize`); the tile's frame never changes shape.
//
// What this spec does NOT prove: that the re-read read something NEW. Both
// scans already read #160 Darren McFadden before the crop, so the card lands
// matched either way; the re-read's eligibility and identity patch are the
// unit tests' (`convex/photoEdits.test.ts`). The STORED-mode viewer (a photo
// with no scan behind it) is card-photo-viewer-rotate-crop-saved-copy.
//
// R7/R7a: writes only a hand-made, per-attempt set (`intkr-<ATTEMPT_TOKEN>`,
// SET-REGISTRY.md) under the real Baseball > 2024 > Topps, with no marketplace
// id beneath it: one hand-added card with the real player's name (what the scans
// read; scoped by the set). One intake run (closed with "Done adding photos"),
// the hand edits of its two scans, and the copy it saves into Main (removed
// through the drawer). Self-cleaning on any path (the finally).
//
// R5: the upload and the first read are the placeholder pipeline's exception
// (PIPELINE, as in add-cards-from-photos-real-scans); the edit landing (render,
// re-read, re-match) is EDIT_LANDS (support/photo-viewer.ts, Jason 2026-11-10).
// Every collector action and our own writes (the edit accepted, "Touching it
// up…") run at 7 s.
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Locator } from "@playwright/test";
import { addCardViaForm, escapeRe } from "../../support/cards";
import { collectorCascade, confirmRemoved, intakeDropzone, pickIntakeSet } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { EDIT_LANDED, EDIT_LANDS, STORED_MODE, servedPhotoSize } from "../../support/photo-viewer";
import { VARIANT_TYPES_SYNC, columnHeading, drillToCustom, selectOrCreate, setBuilderReady } from "../../support/set-builder";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "intake");
const scans = (...names: string[]) => names.map((n) => path.join(FIXTURES, n));
/** The placeholder pipeline's exception: the same ceiling as add-cards-from-photos-real-scans (NEO-407). */
const PIPELINE = 480_000;

test(
  "Add cards: a waiting scan is cropped by hand on its original and read again, and the saved copy's photo is the edited one",
  { tag: ["@collection"] },
  async ({ page, signIn, env, isMobile }) => {
    const setName = `intkr-${env.ATTEMPT_TOKEN}`;
    const label = "#160 Darren McFadden";
    const doneButton = page.getByRole("button", { name: "Done adding photos" });
    const runClosedNote = page.getByText("This run's photos are all in. To add more, start a new run.");
    let doneClicked = false;
    let copyLeft = false;
    let bodyPassed = false;
    let runUrl = "";

    // The card's drawer, from the collection's Checklists.
    const openDrawer = async () => {
      await page.goto("/collection?tab=checklists");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
      const { drill } = collectorCascade(page);
      await drill("Sports", "Baseball", "Years");
      await drill("Years", "2024", "Brands");
      await drill("Brands", "Topps", "Sets");
      await drill("Sets", setName, "Variant Types");
      await drill("Variant Types", "Insert");
      await drill("Insert", "Base");
      const checklist = page.getByRole("region", { name: `2024 ${setName} Base`, exact: true });
      await checklist.getByRole("button", { name: "Details for #160", exact: true }).click();
      const drawer = page.getByRole("dialog", { name: new RegExp(`^2024 ${escapeRe(setName)}.*#160`) });
      await expect(drawer).toBeVisible();
      // The form names the card, it links no player, so the checklist calls it "#160".
      const yourCopies = drawer.getByRole("region", { name: "Your copies of #160", exact: true });
      // The line's front, beside its words: the picture inside "Open photos of <line>".
      const thumb = yourCopies.getByRole("button", { name: /^Open photos of / }).getByRole("img", { name: /^Front of / });
      return { drawer, yourCopies, thumb };
    };

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

      // --- The run: Main, this set's Base, the card's front and back ------------------------------
      await page.goto("/collection?tab=add");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
      await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });
      await pickIntakeSet(page, { sport: "Baseball", year: "2024", manufacturer: "Topps", set: setName }, { under: "Insert" });
      await intakeDropzone(page).setInputFiles(scans("01-mcfadden-front.jpg", "02-mcfadden-back.jpg"));
      await expect(page.getByRole("status").filter({ hasText: "Sent 2 photos." })).toBeVisible({ timeout: PIPELINE });
      await expect(page).toHaveURL(/[?&]run=/);
      runUrl = page.url();
      const runStatus = page.getByRole("status").filter({ hasText: /^(Working on your photos\.|Everything is read\..*|Done reading\..*|\d+ saved\..*)$/ });
      await expect(runStatus).toHaveText("Everything is read. 1 waiting for you, 0 saved.", { timeout: PIPELINE });
      const waiting = page.getByRole("region", { name: /^Needs you, \d+$/ });
      const saved = page.getByRole("region", { name: /^Saved, \d+$/ });
      const tile = waiting.getByRole("article", { name: label, exact: true });
      await expect(tile.getByText(/^Matched \d+%$/)).toBeVisible();

      const openFront = tile.getByRole("button", { name: `Open front of ${label}`, exact: true });
      const viewer = page.getByRole("dialog", { name: `Front of ${label}`, exact: true });
      const backViewer = page.getByRole("dialog", { name: `Back of ${label}`, exact: true });
      const sideOf = (v: Locator, side: "Front" | "Back") =>
        v.getByRole("radiogroup", { name: "Which side" }).getByRole("radio", { name: side, exact: true });
      const tools = viewer.getByRole("toolbar", { name: "Photo tools" });
      // The viewer has two live lines once cropping (the angle note is the other), so a
      // line is found by what it says (GUIDE: duplicated live regions).
      const said = (words: string) => viewer.getByRole("status").filter({ hasText: new RegExp(`^${escapeRe(words)}$`) });
      const cropByHand = tools.getByRole("button", { name: "Crop by hand", exact: true });

      // --- The keyboard and the review drawer open the viewer too --------------------------------
      // e on the selected card opens its front; the side switch shows its back.
      await tile.getByRole("button", { name: `Yes, save ${label}`, exact: true }).focus();
      await page.keyboard.press("e");
      await expect(viewer).toBeVisible();
      await expect(sideOf(viewer, "Front")).toBeChecked();
      await sideOf(viewer, "Back").click();
      await expect(backViewer).toBeVisible();
      await expect(sideOf(backViewer, "Back")).toBeChecked();
      await expect(backViewer.getByRole("img", { name: `Back of ${label}`, exact: true })).toBeVisible();
      await backViewer.getByRole("button", { name: "Close", exact: true }).click();
      await expect(backViewer).toBeHidden();
      // The review drawer (named by the card) has the pair; its back opens on the back.
      await tile.getByRole("button", { name: `Review ${label}`, exact: true }).click();
      const review = page.getByRole("dialog", { name: label, exact: true });
      await expect(review).toBeVisible();
      const reviewBack = review.getByRole("button", { name: `Open back of ${label}`, exact: true });
      await reviewBack.click();
      await expect(backViewer).toBeVisible();
      await expect(sideOf(backViewer, "Back")).toBeChecked();
      // Escape closes only the viewer, and the keyboard is back on the photo it came from.
      await page.keyboard.press("Escape");
      await expect(backViewer).toBeHidden();
      await expect(reviewBack).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(review).toBeHidden();

      // --- Open the front: the scan's original, the box on the auto crop -----------------------------
      await openFront.click();
      await expect(cropByHand).toBeVisible();
      // The original is there, so the crop can go anywhere: no "can only trim" line (tools first, R2).
      await expect(viewer.getByText(STORED_MODE, { exact: true })).toHaveCount(0);
      await cropByHand.click();
      await expect(cropByHand).toHaveAttribute("aria-pressed", "true");
      const cropBox = viewer.getByRole("application", { name: "Crop box", exact: true });
      await expect(cropBox).toBeVisible();
      // The pipeline found the card, so the box opens on its auto crop, not the whole frame.
      // (The auto crop is the preprocess `crop_box` this PR adds: a deployment on an older
      // preprocess shows the note, so this line proves itself on the PR preview.)
      await expect(viewer.getByText("No auto crop here. Drag the box to fit the card.", { exact: true })).toHaveCount(0);

      // Phones keep the width, height and tilt steps (and the Angle field) behind
      // "More steps"; from sm up they show and the button is hidden.
      const moreSteps = viewer.getByRole("button", { name: "More steps", exact: true });
      if (isMobile) {
        await expect(moreSteps).toHaveAttribute("aria-expanded", "false");
        await moreSteps.click();
        await expect(moreSteps).toHaveAttribute("aria-expanded", "true");
      } else {
        await expect(moreSteps).toBeHidden();
      }
      // The box reads itself out once it holds still: angle, size in the scan's pixels, place.
      const angle = viewer.getByRole("spinbutton", { name: "Angle, degrees", exact: true });
      const readout = viewer.getByText(/^Tilted -?\d+°, \d+ by \d+ pixels, \d+% from the left and \d+% from the top\.$/);
      const readSize = async (): Promise<{ w: number; h: number } | null> => {
        const m = /, (\d+) by (\d+) pixels/.exec((await readout.textContent()) ?? "");
        return m ? { w: Number(m[1]), h: Number(m[2]) } : null;
      };

      // --- By pointer: a corner resizes the box, the round handle spins it -----------------------
      // Square it, shrink it to about half (15 steps of 4%) and push it down to the
      // picture's bottom edge by keys. The spin handle then has room above the
      // top edge, where it goes first (spinHandle in CropStage; it moves below or
      // inside only when above would leave the picture), so the box's drawn bounds
      // are its corners' 22 px touch rings (HIT) with the handle's ring on top.
      const RING = 22;
      await angle.fill("0");
      await cropBox.focus();
      for (let i = 0; i < 15; i++) await page.keyboard.press("-");
      for (let i = 0; i < 12; i++) await page.keyboard.press("Shift+ArrowDown");
      await expect(readout).toHaveText(/^Tilted 0°, /);
      const squared = await readSize();
      expect(squared, "the readout's size").not.toBeNull();
      const drawn = await cropBox.boundingBox();
      expect(drawn, "the crop box is drawn").not.toBeNull();
      const corner = { x: drawn!.x + drawn!.width - RING, y: drawn!.y + drawn!.height - RING };
      await page.mouse.move(corner.x, corner.y);
      await page.mouse.down();
      await page.mouse.move(corner.x - 40, corner.y - 40, { steps: 8 });
      await page.mouse.up();
      // The bottom-right corner came in: narrower and shorter, in the readout.
      await expect
        .poll(async () => {
          const now = await readSize();
          return now !== null && now.w < squared!.w && now.h < squared!.h;
        })
        .toBe(true);
      const resized = await cropBox.boundingBox();
      expect(resized, "the crop box is drawn").not.toBeNull();
      const knob = { x: resized!.x + resized!.width / 2, y: resized!.y + RING };
      await page.mouse.move(knob.x, knob.y);
      await page.mouse.down();
      await page.mouse.move(knob.x + 120, knob.y + 30, { steps: 8 });
      await page.mouse.up();
      // Swung to the right: the box is tilted, and the Angle field says so.
      await expect(angle).not.toHaveValue("0");
      await expect(readout).not.toHaveText(/^Tilted 0°, /);

      // --- Tilt the box 4°, turn the photo a quarter, Save ----------------------------------------
      await angle.fill("4");
      await expect(readout).toHaveText(/^Tilted 4°, /);
      // The crop's size before the turn: the saved file is this, on its side (below).
      const cropped = await readSize();
      expect(cropped, "the readout's size").not.toBeNull();
      await tools.getByRole("button", { name: "Turn right", exact: true }).click();
      await expectAccessible(page, { within: viewer, label: "Card photo viewer, cropping a scan's original by hand" });
      await viewer.getByRole("button", { name: "Save photo", exact: true }).click();
      // Our own write (7 s): accepted at once.
      await expect(said("Saved.")).toBeVisible();
      await viewer.getByRole("button", { name: "Close", exact: true }).click();
      await expect(viewer).toBeHidden();
      await expect(openFront).toBeFocused();

      // --- The tile touches it up, reads it again, and lands matched ------------------------------
      // The opener's description is the tile's state (the button keeps its name):
      // "Touching it up…" from the Save until the render lands, then nothing.
      await expect(openFront).toHaveAccessibleDescription("Touching it up…");
      await expectAccessible(page, { label: "Add cards, a scan touching up after a hand crop" });
      // Render, re-read and re-match: EDIT_LANDS.
      await expect(openFront).toHaveAccessibleDescription("", { timeout: EDIT_LANDS });
      // Landed, not failed: no "Keep the old photo" offer (the empty description above
      // is not "Edit didn't save" either).
      await expect(tile.getByRole("button", { name: `Keep the old photo: the front of ${label}`, exact: true })).toHaveCount(0);
      await expect(runStatus).toHaveText("Everything is read. 1 waiting for you, 0 saved.", { timeout: EDIT_LANDS });
      await expect(tile.getByText(/^Matched \d+%$/)).toBeVisible();
      await expect(tile.getByText(/^Read: #160 · .*mcfadden/i)).toBeVisible();

      // --- Save the card: its photos come along, edit and all --------------------------------------
      await tile.getByRole("button", { name: `Yes, save ${label}`, exact: true }).click();
      copyLeft = true;
      await expect(saved).toHaveAccessibleName("Saved, 1");
      const savedTile = saved.getByRole("listitem").filter({ has: page.getByText(label, { exact: true }) });
      await expect(savedTile.getByText("Photos are in!", { exact: true })).toBeVisible();
      {
        const { drawer, yourCopies, thumb } = await openDrawer();
        const { w, h } = await servedPhotoSize(page, thumb, "src");
        // Turned a quarter: the saved front is landscape.
        expect(w, `the saved front is landscape (${w}x${h})`).toBeGreaterThan(h);
        await expectAccessible(page, { within: drawer, label: "Card drawer, a copy saved with a hand-cropped scan" });
        // The full-size file is the crop the readout named, on its side: W by H read
        // before the turn is H by W now, scaled down to the 1600 px long edge a
        // saved photo keeps (one pixel either way for the rounding).
        await yourCopies.getByRole("button", { name: /^Open photos of / }).click();
        const lineViewer = page.getByRole("dialog", { name: /^Front of #160\b/ });
        const full = lineViewer.getByRole("img", { name: /^Front of #160\b/ });
        await expect(full).toHaveAttribute("src", /\/copy-photo\/[0-9a-f]{32}\/image$/);
        const served = await servedPhotoSize(page, full, "src");
        const k = Math.min(1, 1600 / Math.max(cropped!.w, cropped!.h));
        expect(Math.abs(served.w - cropped!.h * k), `served ${served.w}x${served.h}, crop ${cropped!.w}x${cropped!.h}`).toBeLessThanOrEqual(1);
        expect(Math.abs(served.h - cropped!.w * k), `served ${served.w}x${served.h}, crop ${cropped!.w}x${cropped!.h}`).toBeLessThanOrEqual(1);
        await page.keyboard.press("Escape");
        await expect(lineViewer).toBeHidden();
        // The drawer rides on the URL: Back closes it.
        await page.goBack();
        await expect(drawer).toBeHidden();
      }

      // --- From its Saved tile, once more: the original is still there -------------------------------
      await page.goto(runUrl);
      await expect(saved).toHaveAccessibleName("Saved, 1", { timeout: LAUNCH_GATE });
      await savedTile.getByRole("button", { name: `Open saved photo of ${label}`, exact: true }).click();
      await expect(tools.getByRole("button", { name: "Turn left", exact: true })).toBeVisible();
      await expect(viewer.getByText(STORED_MODE, { exact: true })).toHaveCount(0);
      await expectAccessible(page, { within: viewer, label: "Card photo viewer, a saved copy's photo on its scan's original" });
      await tools.getByRole("button", { name: "Turn left", exact: true }).click();
      await viewer.getByRole("button", { name: "Save photo", exact: true }).click();
      await expect(said("Saved.")).toBeVisible();
      await expect(said(EDIT_LANDED)).toBeVisible({ timeout: EDIT_LANDS });
      await viewer.getByRole("button", { name: "Close", exact: true }).click();
      await expect(viewer).toBeHidden();

      // --- Done adding photos; the drawer follows the edit ------------------------------------------
      await doneButton.click();
      doneClicked = true;
      await expect(runClosedNote).toBeVisible();
      {
        const { drawer, yourCopies, thumb } = await openDrawer();
        const { w, h } = await servedPhotoSize(page, thumb, "src");
        // Turned back: portrait again.
        expect(h, `the saved front is portrait again (${w}x${h})`).toBeGreaterThan(w);
        // Clean up the copy (R7).
        await yourCopies.getByRole("button", { name: /^Remove #160\b/ }).click();
        await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
        await confirmRemoved(drawer);
        copyLeft = false;
        await drawer.getByRole("button", { name: "Close card detail" }).click();
        await expect(drawer).toBeHidden();
      }
      bodyPassed = true;
    } finally {
      // Self-cleaning on any path (R7): close the run, remove the copy. One step
      // failing never skips the other; a failure is thrown only when the body
      // passed, else noted (the body's own failure is the one to read).
      const left: unknown[] = [];
      const tidy = async (step: () => Promise<void>) => {
        try {
          await step();
        } catch (e) {
          left.push(e);
        }
      };
      // A run that started but never said "Sent" still holds one of the two run slots.
      const openRun = runUrl || (/[?&]run=/.test(page.url()) ? page.url() : "");
      if (!doneClicked && openRun) {
        await tidy(async () => {
          // A fresh load: an open viewer would leave the page behind it inert.
          await page.goto(openRun);
          await doneButton.click();
          await expect(runClosedNote).toBeVisible();
        });
      }
      if (copyLeft) {
        await tidy(async () => {
          const { drawer, yourCopies } = await openDrawer();
          await yourCopies.getByRole("button", { name: /^Remove #160\b/ }).click();
          await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
          await confirmRemoved(drawer);
        });
      }
      if (left.length > 0) {
        if (bodyPassed) throw left[0];
        test.info().annotations.push({ type: "cleanup-failed", description: String(left[0]) });
      }
    }
  },
);
