// NEO-452 (R1): Add cards takes photos at any time and holds them in the browser
// until the run is set up, then sends them on its own. Nothing is uploaded and no
// run exists until the run has a set (and, for a box that lists, a price).
//
// Two halves of the one feature:
//   1. A box that does not list. Its Defaults carry a Min price, and a button
//      beside it, "Save as common price", turns that Min price into the
//      collector's own common price for the set picked. The button is
//      aria-disabled (still a Tab stop) while the field is blank; with a price
//      typed, one press saves it, the status line says so with an Undo, the Min
//      price goes blank (it is the common price now, not each copy's own floor;
//      a different price typed next reads "Replace $0.75 common price", proof it
//      landed), and Undo puts the Min price back and takes the common price off
//      again. A box
//      that does not list gets no price warning; the button is there anyway.
//   2. The Main binder. A photo pair dropped with no set picked shows no price
//      warning, puts no `run=` on the URL and sits in a tray ("2 photos waiting.
//      Pick a set and they're off."). Remove photos empties the tray and moves
//      focus to the drop zone, and the same files can be dropped again. A trip to
//      the Checklists tab and Back keeps the tray. Picking the set starts the run
//      on its own: "Sent 2 photos." with `run=` on the URL. "Done adding photos"
//      then closes the run so its batch slot frees.
//
// The price warning itself ("Price tag first! ...", Defaults opening on the Min
// price) needs a real listing state (a box that lists, a syncing sign-in, no
// common price), which only the seller spec has: it is proven live in
// `inventory-bsc-listing-1988-topps-base` step 2b, never here.
//
// R7/R7a: writes only the signed-in user's own rows against the seed's 2024
// Topps Chrome Base (read-only, SET-REGISTRY.md): a minted box (deleted at the
// end), the common price (undone, and cleared through the UI by the failure
// path), and one intake run (closed). It never writes the set, its cards,
// players or teams. Minted names are single tokens from `env.ATTEMPT_TOKEN`.
//
// R3: set pick, drop zone and box helpers from `support/collection.ts`.
//
// R5: every wait is the standard 7 s, "Sent 2 photos." (the upload leg of two
// real scans to storage) included; the spec does not wait for the photos to be
// read. Every collector action runs at 7 s.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeRe } from "../../support/cards";
import {
  TOPPS_CHROME_2024,
  clearChecklistCommonPrice,
  createBox,
  deleteOpenBox,
  drillToCollectorBase,
  intakeDropzone,
  inventoryTabs,
  pickIntakeSet,
} from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "intake");
const PHOTOS = ["01-mcfadden-front.jpg", "02-mcfadden-back.jpg"].map((n) => path.join(FIXTURES, n));

test(
  "Add cards: photos wait until a set is picked, then go up on their own; a box's Min price can become the common price",
  { tag: ["@collection"] },
  async ({ page, signIn, env }) => {
    const boxName = `Hold${env.ATTEMPT_TOKEN}`;
    const said = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
    const priceTagWarning = page.getByText(/^Price tag first!/);
    let commonPriceSaved = false;
    let tidyBox = false;
    let runClosed = false;
    const doneButton = page.getByRole("button", { name: "Done adding photos" });
    const runClosedNote = page.getByText("This run's photos are all in. To add more, start a new run.");
    try {
      // --- A box that does not list ------------------------------------------------
      await signIn("/inventory?tab=boxes");
      await expect(page.getByRole("heading", { level: 1, name: "Inventory" })).toBeVisible({ timeout: LAUNCH_GATE });
      await createBox(page, boxName);
      tidyBox = true;
      const listed = page.getByRole("checkbox", { name: "Listed on marketplaces", exact: true });
      await expect(listed).toBeChecked();
      await listed.uncheck();
      await expect(said(`${boxName} is in-person only now.`)).toBeVisible();
      await expect(listed).not.toBeChecked();

      await inventoryTabs(page).getByRole("link", { name: "Add cards", exact: true }).click();
      await expect(page).toHaveURL(/[?&]tab=add/);
      await page.getByRole("combobox", { name: "Put them in this box" }).selectOption({ label: boxName });
      const title = await pickIntakeSet(page, TOPPS_CHROME_2024);
      // It does not list, so there is no price to ask for: no warning, Defaults stay shut.
      const defaults = page.getByRole("button", { name: /^Defaults: / });
      await expect(defaults).toHaveAttribute("aria-expanded", "false");
      await expect(priceTagWarning).toHaveCount(0);
      await defaults.click();
      const minPrice = page.getByRole("textbox", { name: "Min price", exact: true });
      await expect(minPrice).toHaveValue("");
      // Blank: the button is on screen, aria-disabled, and says which set it is for.
      const save = page.getByRole("button", { name: `Save as common price for ${title}`, exact: true });
      await expect(save).toBeVisible();
      await expect(save).toHaveAttribute("aria-disabled", "true");
      await expect(save).toBeDisabled();
      await expectAccessible(page, { label: "Add cards, Defaults open with Save as common price held" });

      // A price typed: the button wakes, one press saves it and clears the Min price.
      await minPrice.fill("0.75");
      await expect(save).toBeEnabled();
      await save.click();
      commonPriceSaved = true;
      await expect(said(`Common price for ${title} is $0.75`)).toBeVisible();
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await expect(undo).toBeVisible();
      await expect(minPrice).toHaveValue("");
      await expect(defaults).toHaveAccessibleName(/^Defaults: [^,]+$/);
      // The common price landed: a different price typed now offers to replace it.
      await minPrice.fill("0.80");
      const replace = page.getByRole("button", { name: `Replace $0.75 common price for ${title}`, exact: true });
      await expect(replace).toBeEnabled();
      await expectAccessible(page, { label: "Add cards, Min price saved as the common price" });

      // Undo: the Min price comes back and the common price goes.
      await undo.click();
      await expect(said("Undone.")).toBeVisible();
      commonPriceSaved = false;
      await expect(minPrice).toHaveValue("0.75");
      await expect(defaults).toHaveAccessibleName(/^Defaults: .*, \$0\.75$/);
      await expect(page.getByRole("button", { name: `Save as common price for ${title}`, exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: /^Replace \$/ })).toHaveCount(0);

      // The box is tidied through the shelf: deleted, so it leaves nothing behind.
      await page.goto("/inventory?tab=boxes");
      await expect(page.getByRole("list", { name: "Your boxes" })).toBeVisible({ timeout: LAUNCH_GATE });
      await page
        .getByRole("list", { name: "Your boxes" })
        .getByRole("button", { name: new RegExp(`^${boxName}, box,`) })
        .click();
      await expect(page).toHaveURL(/[?&]b=[^&]+/);
      await deleteOpenBox(page, boxName);
      tidyBox = false;

      // --- The Main binder: photos wait for a set ----------------------------------
      await page.goto("/collection?tab=add");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
      await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });
      await expect(page.getByRole("button", { name: "Set: pick one", exact: true })).toBeVisible();
      const dropzone = intakeDropzone(page);
      const waiting = "2 photos waiting. Pick a set and they're off.";
      const tray = said(waiting);
      await dropzone.setInputFiles(PHOTOS);
      await expect(tray).toBeVisible();
      // The zone's description holds the hint too, so the tray's words are read inside it.
      await expect(dropzone).toHaveAccessibleDescription(new RegExp(escapeRe(waiting)));
      await expect(priceTagWarning).toHaveCount(0);
      await expect(page).not.toHaveURL(/[?&]run=/);
      await expectAccessible(page, { label: "Add cards, photos waiting for a set" });

      // Remove photos: the tray empties and the keyboard lands on the drop zone.
      await page.getByRole("button", { name: "Remove photos", exact: true }).click();
      await expect(tray).toHaveCount(0);
      await expect(said("Photos removed.")).toBeVisible();
      await expect(dropzone).toBeFocused();
      // The same files can be dropped again.
      await dropzone.setInputFiles(PHOTOS);
      await expect(tray).toBeVisible();

      // A trip to Checklists and Back keeps the tray (and the binder).
      await page
        .getByRole("navigation", { name: "Collection sections" })
        .getByRole("link", { name: "Checklists", exact: true })
        .click();
      await expect(page).toHaveURL(/[?&]tab=checklists/);
      await expect(page.getByRole("group", { name: "Sport, year, brand and set" })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(/[?&]tab=add/);
      await expect(tray).toBeVisible();
      await expect(page).not.toHaveURL(/[?&]run=/);
      await expect(page.getByRole("combobox", { name: "Put them in this binder" }).getByRole("option", { name: "Main", selected: true })).toHaveCount(1);

      // Picking the set sends them on their own: no button, a run on the URL.
      await pickIntakeSet(page, TOPPS_CHROME_2024);
      await expect(said("Sent 2 photos.")).toBeVisible();
      await expect(page).toHaveURL(/[?&]run=/);
      await expect(tray).toHaveCount(0);
      await expectAccessible(page, { label: "Add cards, the held photos sent" });

      // Done adding photos closes the run, so its batch slot frees for the next spec.
      await doneButton.click();
      await expect(runClosedNote).toBeVisible();
      await expect(doneButton).toHaveCount(0);
      runClosed = true;
    } finally {
      // Self-cleaning on any path (R7): close the run so it frees its batch slot,
      // clear a common price the failure left, delete a box left on the shelf.
      // A run exists once its id is on the URL; it may still be mounting when a
      // step failed, so wait (7 s) for either its Done button or the closed note.
      if (!runClosed && /[?&]run=/.test(page.url())) {
        await expect(doneButton.or(runClosedNote)).toBeVisible();
        if (await doneButton.isVisible()) {
          await doneButton.click();
          await expect(runClosedNote).toBeVisible();
        }
      }
      if (commonPriceSaved) {
        await page.goto("/inventory?tab=checklists");
        const checklist = await drillToCollectorBase(page, TOPPS_CHROME_2024);
        await clearChecklistCommonPrice(page, checklist, "2024 Topps Chrome Base", "0.75");
      }
      if (tidyBox) {
        await page.goto("/inventory?tab=boxes");
        await page
          .getByRole("list", { name: "Your boxes" })
          .getByRole("button", { name: new RegExp(`^${boxName}, box,`) })
          .click();
        await deleteOpenBox(page, boxName);
      }
    }
  },
);
