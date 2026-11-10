// NEO-431 (R1): a card added by hand with photos is one line the inventory's
// quick count edits. On the Checklists tab a collector opens a card with no
// copy, adds one from the drawer's Add form with a front and a back photo, and
// its quantity field reads 1 with nothing named "also here" (a photo alone sets
// no line apart). The + reads 2 on that one line (the drawer still lists ONE
// line, now "Raw, Excellent ×2", with both photos). Typing 0 removes it, and
// Undo brings it back with its photos: the front is there and really loads.
// Back from the drawer returns to the checklist.
//
// The rest of the quick count (Tab, Undo, other boxes, the cap) is
// inventory-checklist-quick-quantity; the Add form's own photo behaviour is
// add-copy-with-photos-never-stacks.
//
// R7/R7a: writes ONLY the signed-in user's `collectionCopies` and
// `collectionCopyPhotos` in Unsorted, on the FOURTH ordinary Base row (#4; the other
// collection specs use the first three) of the seed's 2024 Topps Chrome Base (SET-REGISTRY.md),
// never the set, its cards, players or teams. Self-cleaning: the count is typed
// back to 0, which detaches the photos for the hourly sweep. The R2 objects land
// in the dev bucket, which expires them after 14 days.
//
// A phone's number pad has no Tab: its Next key sends Enter (GUIDE "Desktop and
// mobile"), so the spec presses Enter there and Tab on a desktop.
import { escapeRe } from "../../support/cards";
import { drillToCollectorBase, expectPhotoServed, ordinaryBaseRows, photoFile, quantityField, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Inventory Checklists: a card added with photos counts 1, + makes it 2 on that one line, 0 removes it and Undo brings it back with its photos",
  { tag: ["@collection"] },
  async ({ page, signIn, isMobile }) => {
    const advance = isMobile ? "Enter" : "Tab";
    const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

    await signIn("/inventory?tab=checklists");
    await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
    const adding = page.getByRole("combobox", { name: "Adding to" });
    await expect(adding).toBeVisible();
    await expect(adding.getByRole("option", { selected: true })).toHaveText("Unsorted");
    const checklist = await drillToCollectorBase(page);
    const unsortedList = checklist.getByRole("list", { name: "Quantities in Unsorted" });
    const row = ordinaryBaseRows(checklist).nth(3);
    await expect(row).toBeVisible();
    const { short } = await shortNameOf(row);
    const field = quantityField(unsortedList, short, "Unsorted");
    await expect(field).toHaveValue("0");
    const rowOfCard = unsortedList
      .getByRole("listitem")
      .filter({ has: page.getByRole("textbox", { name: `Quantity of ${short} in Unsorted`, exact: true }) });
    const drawer = page.getByRole("dialog", { name: new RegExp(`^2024 Topps Chrome ${escapeRe(short)}`) });
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
    const thumb = yourCopies.getByRole("img", { name: /^Front of Raw, Excellent/ });
    // Details on a card with ONE line in the box opens the drawer already editing it,
    // so the line's photos show in the form's Photos box.
    const openLine = async (line: string) => {
      await checklist.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
      await expect(drawer).toBeVisible();
      await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)" })).toBeVisible();
      const form = yourCopies.getByRole("form", { name: `Edit ${line}`, exact: true });
      await expect(form).toBeVisible();
      return form;
    };

    // --- Add a copy by hand with a front and a back photo -----------------------------------
    await checklist.getByRole("button", { name: `Details for ${short}`, exact: true }).click();
    const addForm = drawer.getByRole("form", { name: "Add a copy" });
    await expect(addForm).toBeVisible();
    // It lands in the box the field counts.
    await expect(addForm.getByRole("combobox", { name: "Where it lives" }).getByRole("option", { selected: true })).toHaveText("Unsorted (box, for sale)");
    const panel = addForm.getByRole("region", { name: /^Photos of / });
    await panel.getByLabel("Front photo file", { exact: true }).setInputFiles(photoFile("front.jpg"));
    await panel.getByLabel("Back photo file", { exact: true }).setInputFiles(photoFile("back.jpg"));
    // Held tiles are pictures only: nothing to open full size until the copy is saved.
    await expect(panel.getByRole("img", { name: "Front of your new copy", exact: true })).toBeVisible();
    await expect(panel.getByRole("img", { name: "Back of your new copy", exact: true })).toBeVisible();
    await expect(panel.getByRole("link", { name: /full size/ })).toHaveCount(0);
    // Fully on screen before axe reads it (the drawer slides in).
    await expect(drawer).toBeInViewport({ ratio: 0.99 });
    await expectAccessible(page, { within: drawer, label: "Card drawer, Add form on the Inventory holding a front and a back photo" });
    await addForm.getByRole("button", { name: "Add to inventory" }).click();
    await expect(addForm).toBeHidden();
    await expect(
      drawer.getByRole("status").filter({ hasText: new RegExp(`Added ${escapeRe(short)}, Raw, Excellent.*with its front and back photos\\.`) }),
    ).toBeVisible();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)" })).toBeVisible();
    await expect(thumb).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- The field counts it: 1, and nothing named "also here" ------------------------------
    await expect(field).toHaveValue("1");
    await expect(field).not.toHaveAccessibleDescription(/also here/);
    await expectAccessible(page, { label: "Inventory Checklists, a card added with photos counted 1" });

    // --- + makes it 2 on that one line -------------------------------------------------------
    await rowOfCard.getByRole("button", { name: `Add one ${short} to Unsorted`, exact: true }).click();
    await expect(said(`Boxed 1 more of ${short}. 2 in Unsorted.`)).toBeVisible();
    await expect(field).toHaveValue("2");
    await expect(field).not.toHaveAccessibleDescription(/also here/);
    await expectAccessible(page, { label: "Inventory Checklists, the photo line counted 2" });
    const stacked = await openLine("Raw, Excellent ×2");
    await expect(stacked.getByRole("link", { name: "Front of Raw, Excellent ×2, full size (opens a new tab)", exact: true })).toBeVisible();
    await expect(stacked.getByRole("link", { name: "Back of Raw, Excellent ×2, full size (opens a new tab)", exact: true })).toBeVisible();
    // Back from the drawer returns to the checklist, the count where it was.
    await page.goBack();
    await expect(drawer).toBeHidden();
    await expect(field).toHaveValue("2");

    // --- Typing 0 removes the line ------------------------------------------------------------
    await field.fill("0");
    await page.keyboard.press(advance);
    await expect(said(`Pulled 2 of ${short} from Unsorted, with its photos. 0 left.`)).toBeVisible();
    await expect(field).toHaveValue("0");

    // --- Undo brings it back with its photos, and they load ----------------------------------
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(said("Undone.")).toBeVisible();
    await expect(field).toHaveValue("2");
    const restored = await openLine("Raw, Excellent ×2");
    const restoredFront = restored.getByRole("link", { name: "Front of Raw, Excellent ×2, full size (opens a new tab)", exact: true });
    await expect(restoredFront).toBeVisible();
    await expect(restored.getByRole("link", { name: "Back of Raw, Excellent ×2, full size (opens a new tab)", exact: true })).toBeVisible();
    await expectPhotoServed(page, restoredFront, "href");
    await expectAccessible(page, { within: drawer, label: "Card drawer, the photo line back after Undo" });
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();

    // --- Clean up: type it back to 0 (R7) ------------------------------------------------------
    await expect(field).toHaveValue("2");
    await field.fill("0");
    await page.keyboard.press(advance);
    await expect(said(`Pulled 2 of ${short} from Unsorted, with its photos. 0 left.`)).toBeVisible();
    await expect(field).toHaveValue("0");
  },
);
