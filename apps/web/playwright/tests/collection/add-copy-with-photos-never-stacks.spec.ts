// NEO-431 (R1): the card drawer's Add form takes photos with the copy. A
// signed-in collector marks the FIRST ordinary Base row Have, opens the drawer's
// "Add another copy" form and picks a front and a back photo: they preview in
// the form's Photos box and nothing is saved yet (the previews are the page's
// own, the line list has no photo). Cancel drops them (the reopened form has
// none). They pick both again and press Add: the new line is its OWN line
// beside the identical plain one (it never stacks, "Raw, Excellent ×2" is
// never read) and shows its photo, which really loads; its Edit form shows the
// front and the back. A held photo opens the card photo viewer view-only
// (NEO-481). A second add with a photo, identical to that photo line,
// makes a third line. Then every line is removed.
//
// The box itself (preview, Remove, Swap, status) is the one photo widget the
// edit form and Request a card share; copy-photos-add-replace-remove proves the
// saved side of it and card-request-approve-moves-copy the send. The box's
// refusal of a file that is not a photo is live here. The server turning an
// upload away after the add (CardDetail's "didn't save, try again under Edit")
// is unit-tested (CardDetail / CopyPhotosField), not live: a collector cannot
// make the server refuse a photo the browser resized and checked, so a live
// spec could only fake that failure.
//
// R7/R7a: writes ONLY the signed-in user's `collectionCopies` and
// `collectionCopyPhotos` on one Base card (the row choice every collection spec
// shares; SET-REGISTRY.md), never the set, its cards, players or teams.
// Self-cleaning: every line is removed through the UI, which detaches its
// photos for the hourly sweep; the bootstrap reset clears any left behind. The
// R2 objects land in the dev bucket, which expires them after 14 days.
import { escapeRe } from "../../support/cards";
import { confirmRemoved, drillToCollectorBase, expectPhotoServed, ordinaryBaseRows, photoFile, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { expectHeldPhotoViewOnly } from "../../support/photo-viewer";

test(
  "Collection: the Add form holds a front and back photo until Add, Cancel drops them, and an add with photos is always its own line",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    const checklist = await drillToCollectorBase(page);

    const row = ordinaryBaseRows(checklist).first();
    await expect(row).toBeVisible();
    const { short } = await shortNameOf(row);
    // The Binder picker opens on All, a view that adds nothing (NEO-374): pick Main first.
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });
    const haveOff = checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false });
    await expect(haveOff).not.toHaveAttribute("aria-disabled", "true");
    await haveOff.click();
    await expect(checklist.getByRole("button", { name: `Have ${short}, Raw, Excellent`, exact: true, pressed: true })).toBeVisible();
    // Have flips at once; the server's answer then puts Add and Trade on the row, which moves
    // Details right. Press Details only once that answer has landed, or the press is lost.
    await expect(page.getByRole("status").filter({ hasText: `Added ${short} to Main` })).toBeVisible();
    await expect(checklist.getByRole("button", { name: `Add another ${short}`, exact: true })).toBeVisible();

    // --- The drawer rides on the URL: Back closes it, then "Add another" opens it on the form ---
    const drawer = page.getByRole("dialog", { name: new RegExp(`^2024 Topps Chrome ${escapeRe(short)}`) });
    await checklist.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
    await expect(page).toHaveURL(/[?&]detail=[^&]+/);
    await expect(drawer.getByRole("button", { name: `Add another copy of ${short}`, exact: true })).toBeVisible();
    await page.goBack();
    await expect(drawer).toBeHidden();
    await expect(checklist.getByRole("button", { name: `Have ${short}, Raw, Excellent`, exact: true, pressed: true })).toBeVisible();

    await checklist.getByRole("button", { name: `Add another ${short}`, exact: true }).click();
    await expect(page).toHaveURL(/[?&]mode=add(&|$)/);
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
    await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)" })).toBeVisible();
    const addForm = drawer.getByRole("form", { name: "Add another copy" });
    const addButton = drawer.getByRole("button", { name: `Add another copy of ${short}`, exact: true });
    await expect(addForm).toBeVisible();
    const panel = addForm.getByRole("region", { name: /^Photos of / });
    await expect(panel.getByText("No front photo yet")).toBeAttached();
    await expect(panel.getByText("No back photo yet")).toBeAttached();
    // Fully on screen before axe reads it (the drawer slides in).
    await expect(drawer).toBeInViewport({ ratio: 0.99 });

    // --- A file that is not a photo is refused in the box's own words, and none is held ----
    const refusal = panel.getByRole("alert");
    await panel
      .getByLabel("Front photo file", { exact: true })
      .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a photo") });
    await expect(refusal).toHaveText("Only photos can be added here.");
    await expect(panel.getByText("No front photo yet")).toBeAttached();
    await expect(panel.getByRole("img", { name: "Front of your new copy", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Remove front", exact: true })).toHaveCount(0);
    await expectAccessible(page, { within: drawer, label: "Card drawer, Add form refusing a file that is not a photo" });

    // --- Hold a front and a back: they preview, and nothing is saved ----------------------
    const hold = async () => {
      await panel.getByLabel("Front photo file", { exact: true }).setInputFiles(photoFile("front.jpg"));
      await panel.getByLabel("Back photo file", { exact: true }).setInputFiles(photoFile("back.jpg"));
    };
    await hold();
    // A good pick clears the refusal.
    await expect(refusal).toHaveText("");
    const heldFront = panel.getByRole("img", { name: "Front of your new copy", exact: true });
    const heldBack = panel.getByRole("img", { name: "Back of your new copy", exact: true });
    await expect(heldFront).toBeVisible();
    await expect(heldBack).toBeVisible();
    await expect(panel.getByRole("button", { name: "Remove front", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Remove back", exact: true })).toBeVisible();
    await expect(panel.getByText("Stashed here until you add the copy.")).toBeVisible();
    // Nothing saved yet: the one line has no photo.
    await expect(yourCopies.getByRole("img", { name: /^Front of Raw, Excellent/ })).toHaveCount(0);
    await expectAccessible(page, { within: drawer, label: "Card drawer, Add form holding a front and a back photo" });
    // A held photo opens the card photo viewer view-only until the copy is added
    // (NEO-481): it says why and offers no Save; Escape closes only the viewer.
    await expectHeldPhotoViewOnly(page, panel, "front", "your new copy", "Card photo viewer, a held photo, view-only");
    await expect(addForm).toBeVisible();

    // --- Cancel drops what was held --------------------------------------------------------
    await addForm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(addForm).toBeHidden();
    await expect(addButton).toBeFocused();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)" })).toBeVisible();
    await addButton.click();
    await expect(addForm).toBeVisible();
    await expect(panel.getByText("No front photo yet")).toBeAttached();
    await expect(panel.getByText("No back photo yet")).toBeAttached();
    await expect(heldFront).toHaveCount(0);

    // --- Add with photos: its own line beside the identical plain one -----------------------
    await hold();
    await expect(heldFront).toBeVisible();
    await expect(heldBack).toBeVisible();
    await addForm.getByRole("button", { name: "Add to collection" }).click();
    await expect(addForm).toBeHidden();
    await expect(
      drawer.getByRole("status").filter({ hasText: new RegExp(`Added ${escapeRe(short)}, Raw, Excellent.*with its front and back photos\\.`) }),
    ).toBeVisible();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (2 lines)" })).toBeVisible();
    // Never "Stacked it": the plain line did not take it in.
    await expect(drawer.getByRole("status").filter({ hasText: "Stacked it" })).toHaveCount(0);
    await expect(yourCopies.getByText(/Raw, Excellent ×2/)).toHaveCount(0);
    // The photo is on the new line (the plain one has none), and really loads.
    const thumbs = yourCopies.getByRole("img", { name: /^Front of Raw, Excellent/ });
    await expect(thumbs).toHaveCount(1);
    await expect(thumbs).toBeVisible();
    await expectPhotoServed(page, thumbs, "src");
    await expectAccessible(page, { within: drawer, label: "Card drawer, a new line with its photos beside a plain one" });

    // Its Edit form holds both photos, saved (the box shows the stored pictures now).
    const newLine = yourCopies.getByRole("listitem").filter({ has: page.getByRole("img", { name: /^Front of Raw, Excellent/ }) });
    await newLine.getByRole("button", { name: /^Edit / }).click();
    const editForm = yourCopies.getByRole("form", { name: /^Edit Raw, Excellent/ });
    await expect(editForm).toBeVisible();
    const savedFront = editForm.getByRole("button", { name: /^Open front of Raw, Excellent/ }).getByRole("img", { name: /^Front of Raw, Excellent/ });
    const savedBack = editForm.getByRole("button", { name: /^Open back of Raw, Excellent/ }).getByRole("img", { name: /^Back of Raw, Excellent/ });
    await expect(savedFront).toHaveAttribute("src", /\/copy-photo\/[0-9a-f]{32}\/thumb$/);
    await expect(savedBack).toHaveAttribute("src", /\/copy-photo\/[0-9a-f]{32}\/thumb$/);
    await expectPhotoServed(page, savedBack, "src");
    await editForm.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editForm).toBeHidden();

    // --- A second add with a photo, identical to the photo line: a third line --------------
    await addButton.click();
    await expect(addForm).toBeVisible();
    await panel.getByLabel("Front photo file", { exact: true }).setInputFiles(photoFile("front-again.jpg"));
    await expect(heldFront).toBeVisible();
    await addForm.getByRole("button", { name: "Add to collection" }).click();
    await expect(addForm).toBeHidden();
    await expect(
      drawer.getByRole("status").filter({ hasText: new RegExp(`Added ${escapeRe(short)}, Raw, Excellent.*with its front photo\\.`) }),
    ).toBeVisible();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (3 lines)" })).toBeVisible();
    await expect(yourCopies.getByText(/Raw, Excellent ×2/)).toHaveCount(0);
    await expect(thumbs).toHaveCount(2);

    // --- Remove every line (self-cleaning, R7) ----------------------------------------------
    const removeAny = yourCopies.getByRole("button", { name: new RegExp(`^Remove ${escapeRe(short)}, Raw, Excellent`) });
    // Every "Removed ..." notice reads the same, so confirmRemoved dismisses each one once it
    // has landed: the next wait can only be satisfied by the next Remove's own answer, never a
    // stale notice, and the last Remove is confirmed by the server before the drawer closes.
    await removeAny.first().click();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (2 lines)" })).toBeVisible();
    // The list drops the line optimistically; "Removed ..." is the server's answer, and it
    // replaces the taller "Added ... photo(s)." notice above the list. Press the next Remove
    // only once it has landed, or that reflow moves the button out from under the press.
    await confirmRemoved(drawer);
    await removeAny.first().click();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)" })).toBeVisible();
    await confirmRemoved(drawer);
    await removeAny.first().click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await confirmRemoved(drawer);
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false })).toBeVisible();
  },
);
