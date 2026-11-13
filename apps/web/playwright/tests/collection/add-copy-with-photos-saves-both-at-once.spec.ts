// NEO-466 (R1): an add with a front and a back photo saves the two photos at the
// same time, so the collector is not left waiting on one before the other starts.
// A signed-in collector marks the FIRST ordinary Base row Have, opens the drawer's
// "Add another copy" form, holds a front and a back photo and presses Add while the
// test answers the browser's PUTs of the IMAGE files to the photo store: the first
// image PUT to reach the store is never answered (the front goes up first) and the
// test waits, by event, for a PUT of the OTHER photo's image to start while that one
// is still held. Only then is the held one let through, and the drawer says "Added
// ... with its front and back photos." inside the standard 7 s. Photos saved one
// after the other never start the second PUT while the first is held, so the wait
// for it fails.
//
// Why this mocks: a slow storage answer cannot be made on demand against the live
// store, and "both are in flight at once" is not something a screen shows, so the
// test holds one image PUT and watches the other arrive. Same pattern as
// copy-photo-upload-retry: only the image files' PUTs to the store are routed
// (matched by the signed address's path, never logged), the thumbnails' PUTs and
// everything else go through. Every try of the held file's address is held until the
// release, so the page's own stall timer cutting a try off at 2.5 s cannot let the
// held photo finish early. Release lets the held request through to the real store.
//
// Which photo is held is not told by any screen: it is the first image PUT to arrive
// (the front, which the product starts first). The proof does not depend on it: a
// second, different image file must start while the first is held.
//
// The photo box, the line and Cancel are add-copy-with-photos-never-stacks; the
// retry copy is copy-photo-upload-retry; the Inventory add is
// inventory-photo-line-quick-quantity.
//
// R7/R7a: writes ONLY the signed-in user's `collectionCopies` and
// `collectionCopyPhotos` on one Base card (the row choice every collection spec
// shares; SET-REGISTRY.md), never the set, its cards, players or teams.
// Self-cleaning: every line is removed through the UI, which detaches its photos for
// the hourly sweep; the bootstrap reset clears any left behind. The R2 objects land
// in the dev bucket, which expires them after 14 days.
import { escapeRe } from "../../support/cards";
import { drillToCollectorBase, ordinaryBaseRows, photoFile, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

/** The photo store's signed upload addresses (a different host from the app and Convex). */
const PHOTO_STORE = /^https:\/\/[^/]+\.r2\.cloudflarestorage\.com\//;
/** An image file's object (the thumbnail's is `thumb`), told apart by the path of the signed address (never logged). */
const IMAGE_OBJECT = /\/copy-photos\/([0-9a-f]{32})\/image\.(jpg|webp)$/;
/**
 * Which photo an image PUT is, from the object's own name. A retry goes to the bucket's own host,
 * whose path has no bucket prefix, so the whole path is not the same twice: the object's name is.
 */
const photoOf = (url: string): string | null => IMAGE_OBJECT.exec(new URL(url).pathname)?.[1] ?? null;

test(
  "Collection: an add with a front and a back photo saves both at the same time, so the back never waits on the front",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    await page.getByRole("navigation", { name: "Collection sections" }).getByRole("link", { name: "Checklists", exact: true }).click();
    const checklist = await drillToCollectorBase(page);

    const row = ordinaryBaseRows(checklist).first();
    await expect(row).toBeVisible();
    const { short } = await shortNameOf(row);
    // The Binder picker opens on All, a view that adds nothing (NEO-374): pick Main first.
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });
    await checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false }).click();
    await expect(checklist.getByRole("button", { name: `Have ${short}, Raw, Excellent`, exact: true, pressed: true })).toBeVisible();

    await checklist.getByRole("button", { name: `Add another ${short}`, exact: true }).click();
    const drawer = page.getByRole("dialog", { name: new RegExp(`^2024 Topps Chrome ${escapeRe(short)}`) });
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
    await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)" })).toBeVisible();
    const addForm = drawer.getByRole("form", { name: "Add another copy" });
    await expect(addForm).toBeVisible();
    const panel = addForm.getByRole("region", { name: /^Photos of / });
    await panel.getByLabel("Front photo file", { exact: true }).setInputFiles(photoFile("front.jpg"));
    await panel.getByLabel("Back photo file", { exact: true }).setInputFiles(photoFile("back.jpg"));
    await expect(panel.getByRole("img", { name: "Front of your new copy", exact: true })).toBeVisible();
    await expect(panel.getByRole("img", { name: "Back of your new copy", exact: true })).toBeVisible();

    // The first image file to reach the store is held (every try of it, whichever host);
    // the other file's PUT is let through. `release` lets the held ones go to the real store.
    let heldPhoto: string | null = null;
    let released = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = () => {
        released = true;
        resolve();
      };
    });
    await page.route(PHOTO_STORE, async (route) => {
      const request = route.request();
      const photo = request.method() === "PUT" ? photoOf(request.url()) : null;
      if (photo === null) return route.fallback();
      heldPhoto ??= photo;
      if (photo !== heldPhoto || released) return route.fallback();
      await gate;
      // A try the page's own stall timer already cut off cannot be continued: that is fine.
      return route.fallback().catch(() => {});
    });

    // The second DIFFERENT photo's image PUT, awaited by event (the 7 s budget bounds it): start it
    // BEFORE the press that sends it. The predicate only counts distinct photos, so a retry
    // of the held photo is not "the other one".
    const photos = new Set<string>();
    const otherImagePut = page.waitForRequest((request) => {
      const photo = request.method() === "PUT" ? photoOf(request.url()) : null;
      if (photo === null) return false;
      photos.add(photo);
      return photos.size === 2;
    });

    await addForm.getByRole("button", { name: "Add to collection" }).click();
    // The back's PUT starts while the front's is still held: the two upload side by side.
    await otherImagePut;
    expect(released, "the held photo is still held when the other one starts").toBe(false);

    // Let the held photo through: the copy is in with both photos, inside the standard budget.
    release();
    await expect(
      drawer.getByRole("status").filter({ hasText: new RegExp(`Added ${escapeRe(short)}, Raw, Excellent.*with its front and back photos\\.`) }),
    ).toBeVisible();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (2 lines)" })).toBeVisible();
    await expect(yourCopies.getByRole("img", { name: /^Front of Raw, Excellent/ })).toHaveCount(1);
    await expectAccessible(page, { within: drawer, label: "Card drawer, an add saved with its front and back photos" });

    // --- Remove every line (self-cleaning, R7) ----------------------------------------------
    await page.unroute(PHOTO_STORE);
    const removeAny = yourCopies.getByRole("button", { name: new RegExp(`^Remove ${escapeRe(short)}, Raw, Excellent`) });
    await removeAny.first().click();
    await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)" })).toBeVisible();
    // The list drops the line optimistically; "Removed ..." is the server's answer, and it
    // replaces the taller "Added ... photo(s)." notice above the list. Press the next Remove
    // only once it has landed, or that reflow moves the button out from under the press.
    await expect(
      drawer.getByRole("status").filter({ hasText: new RegExp(`^Removed ${escapeRe(short)}, Raw, Excellent`) }),
    ).toBeVisible();
    await removeAny.first().click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false })).toBeVisible();
  },
);
