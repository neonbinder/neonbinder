// NEO-481 (R1): a saved copy's photo is turned and cropped in the card photo
// viewer, and each edit becomes a NEW saved file. A signed-in collector marks
// an ordinary Base row Have, opens its line's Edit form and adds a front photo
// (a hand-added photo has no scan behind it, so this spec is the viewer's
// STORED-mode proof: the viewer says a crop can only trim what is there).
// They open the photo, Turn right and Save: Save is accepted at once ("Saved.",
// "Touching it up…") and the new file lands in the background, a landscape
// photo where a portrait one was. Escape closes only the viewer, focus back on
// the photo. A reload still shows the turned photo. Reopened, they Crop by hand
// with the keyboard only (shrink, tilt a degree, nudge), the readout naming the
// angle and the size; the saved file is that size. Undo puts the turned photo
// back. Then the copy is removed.
//
// Why the file's size and not the tile's shape: a photo tile keeps its 5:7
// frame whatever the photo inside, so nothing on the page says "landscape".
// What the collector saved is a file, and `servedPhotoSize` reads its size from
// the address their browser downloads (support/photo-viewer.ts). The fixture
// photo is a 50x70 JPEG (`photoFile`), so nothing is ever scaled down: the
// turn makes 70x50 and the crop is exactly the readout's size.
//
// The scan (ORIGINAL-mode) path, where a crop can go anywhere in the frame and
// the pair is read again, is add-cards-recrop-scan-rereads. The photo box
// itself (add, replace, remove, swap) is copy-photos-add-replace-remove.
//
// R7/R7a: writes ONLY the signed-in user's `collectionCopies` and
// `collectionCopyPhotos` on the FIFTH ordinary Base row of the seed's 2024 Topps
// Chrome Base (SET-REGISTRY.md; the other collection specs use the first four),
// never the set, its cards, players or teams. Self-cleaning: the copy is
// removed through the UI, which detaches its photos (the replaced ones sweep
// after the hour); the bootstrap reset clears any left behind. The R2 objects
// land in the dev bucket, which expires them.
//
// R5: every collector action and our own writes (the edit accepted, the
// preview and "Touching it up…" showing) get 7 s. The only longer wait is the
// new file landing, EDIT_LANDS (support/photo-viewer.ts, Jason 2026-11-10).
import { escapeRe } from "../../support/cards";
import { drillToCollectorBase, ordinaryBaseRows, photoFile, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { EDIT_LANDED, EDIT_LANDS, STORED_MODE, photoViewer, servedPhotoSize } from "../../support/photo-viewer";

test(
  "Card photo viewer: a saved copy's photo turns and crops by keyboard into a new saved file, Escape keeps the drawer, and Undo puts the last one back",
  { tag: ["@collection"] },
  async ({ page, signIn, isMobile }) => {
    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    const checklist = await drillToCollectorBase(page);

    const row = ordinaryBaseRows(checklist).nth(4);
    await expect(row).toBeVisible();
    const { short, number } = await shortNameOf(row);
    // The Binder picker opens on All, a view that adds nothing (NEO-374): pick Main first.
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });
    const haveOff = checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false });
    await expect(haveOff).not.toHaveAttribute("aria-disabled", "true");
    await haveOff.click();
    await expect(checklist.getByRole("button", { name: `Have ${short}, Raw, Excellent`, exact: true, pressed: true })).toBeVisible();
    // From here the copy exists until the last step removes it. A render that
    // never lands (a cold or broken preprocess) must not leave it for the
    // worker's next run of this spec: the finally removes it (R7).
    let copyLeft = true;
    const drawer = page.getByRole("dialog", { name: new RegExp(`^2024 Topps Chrome ${escapeRe(short)}`) });
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
    try {
      // --- The line's Edit form, with a front photo ------------------------------------------
      await checklist.getByText(`#${number}`, { exact: true }).click();
      const form = yourCopies.getByRole("form", { name: "Edit Raw, Excellent", exact: true });
      await expect(form).toBeVisible();
      const panel = form.getByRole("region", { name: /^Photos of / });
      await panel.getByLabel("Front photo file", { exact: true }).setInputFiles(photoFile("front.jpg"));
      await expect(panel.getByRole("status")).toHaveText("Front photo saved.");
      const frontTile = panel.getByRole("button", { name: "Open front of Raw, Excellent", exact: true });
      const tilePicture = frontTile.getByRole("img", { name: "Front of Raw, Excellent", exact: true });
      // The photo as added: portrait, the precondition the turn changes (R2).
      expect(await servedPhotoSize(page, tilePicture, "src")).toEqual({ w: 50, h: 70 });

      // --- Open it: the viewer, on a photo it can only trim ----------------------------------
      await frontTile.click();
      const viewer = photoViewer(page, "front", short);
      const tools = viewer.getByRole("toolbar", { name: "Photo tools" });
      // The viewer has two live lines once cropping (the angle note is the other), so a
      // line is found by what it says (GUIDE: duplicated live regions).
      const said = (words: string) => viewer.getByRole("status").filter({ hasText: new RegExp(`^${escapeRe(words)}$`) });
      const viewerPicture = viewer.getByRole("img", { name: `Front of ${short}`, exact: true });
      await expect(viewer.getByText(STORED_MODE, { exact: true })).toBeVisible();
      await expect(tools.getByRole("button", { name: "Turn right", exact: true })).toBeVisible();
      await expect(viewer.getByRole("button", { name: "Save photo", exact: true })).toBeVisible();
      await expectAccessible(page, { within: viewer, label: "Card photo viewer, a saved photo it can only trim" });
      // Keyboard first: focus starts on the heading and Tab reaches the tools. The
      // viewer sits inside the card drawer's own dialog, and a nested trap that
      // swallowed Tab once left a keyboard user stuck on the heading (NEO-481 audit).
      await expect(viewer.getByRole("heading", { name: `Front of ${short}`, exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(tools.getByRole("button", { name: "Turn left", exact: true })).toBeFocused();

      // --- Turn right and Save: accepted at once, the new file lands behind it ----------------
      await tools.getByRole("button", { name: "Turn right", exact: true }).click();
      await viewer.getByRole("button", { name: "Save photo", exact: true }).click();
      // Our own write (7 s): accepted, and the photo is touched up in the background.
      await expect(said("Saved.")).toBeVisible();
      await expect(viewer.getByText("Touching it up…", { exact: true })).toBeVisible();
      // The render: the PIPELINE exception (EDIT_LANDS).
      await expect(said(EDIT_LANDED)).toBeVisible({ timeout: EDIT_LANDS });
      await expect(viewer.getByText("Touching it up…", { exact: true })).toHaveCount(0);
      // A new file, landscape: the old one turned a quarter.
      expect(await servedPhotoSize(page, viewerPicture, "src")).toEqual({ w: 70, h: 50 });
      await expectAccessible(page, { within: viewer, label: "Card photo viewer, an edited photo landed" });

      // --- Escape closes only the viewer; focus goes back to the photo -------------------------
      await page.keyboard.press("Escape");
      await expect(viewer).toBeHidden();
      await expect(form).toBeVisible();
      await expect(frontTile).toBeFocused();
      // The tile shows the new file too.
      expect(await servedPhotoSize(page, tilePicture, "src")).toEqual({ w: 70, h: 50 });

      // --- A reload keeps it: the line's own thumbnail is the turned photo ---------------------
      await page.reload();
      // A reload is a cold launch, like the sign-in's first page (LAUNCH_GATE).
      await expect(drawer).toBeVisible({ timeout: LAUNCH_GATE });
      const editLine = yourCopies.getByRole("button", { name: `Edit ${short}, Raw, Excellent`, exact: true });
      // The drawer settles into one of its two states first; then the branch is free (GUIDE idioms).
      await expect(form.or(editLine)).toBeVisible();
      if (await form.isVisible()) {
        // The drawer came back already editing the line (its URL says so): the photo is in the box.
        expect(await servedPhotoSize(page, tilePicture, "src")).toEqual({ w: 70, h: 50 });
      } else {
        const lineThumb = yourCopies
          .getByRole("button", { name: "Open photos of Raw, Excellent", exact: true })
          .getByRole("img", { name: "Front of Raw, Excellent", exact: true });
        expect(await servedPhotoSize(page, lineThumb, "src")).toEqual({ w: 70, h: 50 });
        await editLine.click();
        await expect(form).toBeVisible();
      }

      // --- Reopen and crop by hand, keyboard only -----------------------------------------------
      await frontTile.click();
      await expect(viewer.getByText(STORED_MODE, { exact: true })).toBeVisible();
      const cropByHand = tools.getByRole("button", { name: "Crop by hand", exact: true });
      await cropByHand.click();
      await expect(cropByHand).toHaveAttribute("aria-pressed", "true");
      // The box is an application region (its keys are its own), named "Crop box".
      const cropBox = viewer.getByRole("application", { name: "Crop box", exact: true });
      const angle = viewer.getByRole("spinbutton", { name: "Angle, degrees", exact: true });
      await expect(cropBox).toBeVisible();
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
      await expect(viewer.getByRole("group", { name: "Move steps", exact: true })).toBeVisible();
      await expect(viewer.getByRole("group", { name: "Size steps", exact: true })).toBeVisible();
      await expect(viewer.getByRole("group", { name: "Width and height steps", exact: true })).toBeVisible();
      await expect(viewer.getByRole("group", { name: "Tilt steps", exact: true })).toBeVisible();
      await expect(angle).toHaveValue("0");
      await expectAccessible(page, { within: viewer, label: "Card photo viewer, cropping by hand" });
      await cropBox.focus();
      await page.keyboard.press("-");
      await page.keyboard.press("-");
      await page.keyboard.press(",");
      await page.keyboard.press("ArrowRight");
      await expect(angle).toHaveValue("-1");
      // The box reads itself out once it holds still: the angle, the size it will save and where it sits.
      const readout = viewer.getByText(/^Tilted -1°, \d+ by \d+ pixels, \d+% from the left and \d+% from the top\.$/);
      await expect(readout).toHaveCount(1);
      const [, cropW, cropH] = /(\d+) by (\d+)/.exec((await readout.textContent()) ?? "") ?? [];
      const cropped = { w: Number(cropW), h: Number(cropH) };
      // A crop of a stored photo can only trim it.
      expect(cropped.w).toBeLessThan(70);
      expect(cropped.h).toBeLessThan(50);
      await viewer.getByRole("button", { name: "Save photo", exact: true }).click();
      await expect(said("Saved.")).toBeVisible();
      await expect(said(EDIT_LANDED)).toBeVisible({ timeout: EDIT_LANDS });
      // The saved file is the crop the readout named.
      expect(await servedPhotoSize(page, viewerPicture, "src")).toEqual(cropped);

      // --- Undo puts the turned photo back -------------------------------------------------------
      await tools.getByRole("button", { name: "Undo", exact: true }).click();
      await expect(said("Put back the photo from before.")).toBeVisible();
      await expect(tools.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
      await expect.poll(() => servedPhotoSize(page, viewerPicture, "src")).toEqual({ w: 70, h: 50 });
      await viewer.getByRole("button", { name: "Close", exact: true }).click();
      await expect(viewer).toBeHidden();
      await expect(frontTile).toBeFocused();

      // --- Remove the copy (self-cleaning, R7) ----------------------------------------------------
      await page.keyboard.press("Escape");
      await expect(form).toBeHidden();
      await yourCopies.getByRole("button", { name: `Remove ${short}, Raw, Excellent`, exact: true }).click();
      await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
      copyLeft = false;
      await drawer.getByRole("button", { name: "Close card detail" }).click();
      await expect(drawer).toBeHidden();
      await expect(checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false })).toBeVisible();
    } finally {
      if (copyLeft) {
        // The body failed with the copy still there. Remove it from a fresh page;
        // a failure here is noted, never thrown over the body's own error.
        try {
          await page.goto("/collection?tab=checklists");
          const again = await drillToCollectorBase(page);
          await again.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
          await yourCopies.getByRole("button", { name: `Remove ${short}, Raw, Excellent`, exact: true }).click();
          await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
        } catch (e) {
          test.info().annotations.push({ type: "cleanup", description: `copy of ${short} left behind: ${String(e).slice(0, 200)}` });
        }
      }
    }
  },
);
