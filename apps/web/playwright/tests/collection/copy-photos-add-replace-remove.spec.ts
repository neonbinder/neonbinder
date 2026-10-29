// NEO-377 (R1): a copy line's photos, live. A signed-in collector marks the
// FIRST ordinary Base row Have and clicks the row, which opens the drawer
// already editing that one line; in the form's Photos box they add a front (resized in the browser, uploaded straight to R2 through
// signed URLs, checked and attached by Convex), sees it on the line and loads
// it through the /copy-photo redirect (the image really decodes), replaces it,
// adds a back, removes the back, swaps the front over and back, closes the
// form with Escape, sees the card itself drawn from the photo, then removes
// the copy and Undoes it (the
// photos come back with it), and finally removes it for good. Drag and drop
// is proven in CopyPhotosField.test.tsx only: Playwright's file drops are not
// reliable enough for a live spec, and Swap is the same write.
//
// R7/R7a: writes ONLY the signed-in user's `collectionCopies` and
// `collectionCopyPhotos` on one Base card (the row choice every collection
// spec shares; see SET-REGISTRY.md), never the set, its cards, players or
// teams. Self-cleaning: the copy is removed through the UI, which detaches its
// photos for the hourly sweep; the bootstrap reset clears any left behind.
// The R2 objects land in the dev bucket, which expires them after 14 days.
import { drillToCollectorBase, ordinaryBaseRows, shortNameOf } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

// A 50x70 JPEG, inline: no fixture file to keep.
const CARD_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCABGADIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCcDccCl8s+1Ef3vwptYxjQp0IznBttvrba3k+5+YjvLPtR5Z9qbRU+1wv/AD6f/gX/AAA1HeWfakKlRk0lOP8Aqx9a0gsPVhPlg00r736ry8w1G0UUV5ox0f3vwptOj+9+FNruq/7rS9ZfoLqFFFFcIwpx/wBWPrTacf8AVj613YT4av8Ahf5oTG0UUVwjHR/e/Cm06P734U2u6r/utL1l+guoUUUVwjCnH/Vj602nH/Vj613YT4av+F/mhMbRRRXCMdH978KbTo/vfhSbG9K9KVGpUwtPki3rLZX7C6iUUuxvSjY3pXN9UxH/AD7l9zHdCU4/6sfWk2N6UrDEYB9a68PQq04VXOLS5XumuqExtFFFeWMM46Ubj6miirjUnFWTYBuPqaNx9TRRVe2qfzP7wDcfU0ZJ6miik6s2rOTAKKKKzA//2Q==",
  "base64",
);
const photoFile = (name: string) => ({ name, mimeType: "image/jpeg", buffer: CARD_JPEG });

test(
  "Collection: add, replace and remove a copy's front and back photos; Undo of a remove brings them back",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    await signIn("/collection");
    await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    await tabs.getByRole("link", { name: "Checklists", exact: true }).click();
    const checklist = await drillToCollectorBase(page);

    const row = ordinaryBaseRows(checklist).first();
    await expect(row).toBeVisible();
    const { short, number } = await shortNameOf(row);
    // The Binder picker opens on All, a view that adds nothing (NEO-374): pick Main first.
    await checklist.getByRole("combobox", { name: "Binder" }).selectOption({ label: "Main" });
    const haveOff = checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false });
    await expect(haveOff).not.toHaveAttribute("aria-disabled", "true");
    await haveOff.click();
    await expect(checklist.getByRole("button", { name: `Have ${short}, Raw, Excellent`, exact: true, pressed: true })).toBeVisible();

    // --- A click on the row opens the drawer already editing its one line ----
    await checklist.getByText(`#${number}`, { exact: true }).click();
    const drawer = page.getByRole("dialog", { name: /^2024 Topps Chrome / });
    const yourCopies = drawer.getByRole("region", { name: `Your copies of ${short}` });
    await expect(yourCopies.getByRole("heading", { name: "Your copies (1 line)" })).toBeVisible();
    const form = yourCopies.getByRole("form", { name: "Edit Raw, Excellent", exact: true });
    await expect(form).toBeVisible();
    const panel = form.getByRole("region", { name: "Photos", exact: true });
    await expect(panel.getByText("No front photo yet")).toBeAttached();
    await expectAccessible(page, { within: drawer, label: "Card drawer, editing, no photos" });

    // --- Add a front: it uploads, shows on the line and really loads ---------
    const front = panel.getByLabel("Front photo file", { exact: true });
    const back = panel.getByLabel("Back photo file", { exact: true });
    await front.setInputFiles(photoFile("front.jpg"));
    await expect(panel.getByRole("status")).toHaveText("Front photo saved.");
    // While the form is open the line is the form, so the photo shows in the box.
    const fullSize = panel.getByRole("link", { name: "Front of Raw, Excellent, full size (opens a new tab)", exact: true });
    await expect(fullSize).toHaveAttribute("href", /\/copy-photo\/[0-9a-f]{32}\/image$/);
    const firstHref = await fullSize.getAttribute("href");
    await expectAccessible(page, { within: drawer, label: "Card drawer, front photo on" });

    // --- Replace it: a new photo, a new address -------------------------------
    await panel.getByRole("button", { name: "Replace front", exact: true }).click();
    await front.setInputFiles(photoFile("front-2.jpg"));
    await expect(fullSize).not.toHaveAttribute("href", firstHref ?? "");
    await expect(panel.getByRole("status")).toHaveText("Front photo saved.");

    // --- A back, then off again ----------------------------------------------
    await back.setInputFiles(photoFile("back.jpg"));
    await expect(panel.getByRole("status")).toHaveText("Back photo saved.");
    await expect(panel.getByRole("link", { name: "Back of Raw, Excellent, full size (opens a new tab)", exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Remove back", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Back photo removed.");
    await expect(panel.getByText("No back photo yet")).toBeAttached();

    // --- Swap: the front becomes the back ------------------------------------
    await panel.getByRole("button", { name: "Swap front and back", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Front and back swapped.");
    await expect(panel.getByText("No front photo yet")).toBeAttached();
    await panel.getByRole("button", { name: "Swap front and back", exact: true }).click();
    await expect(panel.getByRole("status")).toHaveText("Front and back swapped.");
    await expect(panel.getByText("No back photo yet")).toBeAttached();

    // --- Escape closes the form (photos are already saved); keyboard on Edit --
    await panel.getByRole("button", { name: "Replace front", exact: true }).focus();
    await page.keyboard.press("Escape");
    await expect(form).toBeHidden();
    await expect(yourCopies.getByRole("button", { name: `Edit ${short}, Raw, Excellent`, exact: true })).toBeFocused();
    // Back on the line: its thumbnail came through /copy-photo (Convex) -> a signed R2 URL, and decoded.
    const lineThumb = yourCopies.getByRole("img", { name: "Front of Raw, Excellent", exact: true });
    await expect(lineThumb).toBeVisible();
    await expect(lineThumb).toHaveAttribute("src", /\/copy-photo\/[0-9a-f]{32}\/thumb$/);
    await expect.poll(() => lineThumb.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    // The card itself is now drawn from the photo, not the generated stand-in:
    // the drawer's card face reads it through the same one-query-per-screen
    // path (cardPhotos) that binder pages and search results use.
    await expect
      .poll(() =>
        drawer
          .getByRole("img")
          .evaluateAll((faces) =>
            faces.some(
              (face) =>
                face.classList.contains("nb-card") &&
                /\/copy-photo\/[0-9a-f]{32}\/thumb$/.test(face.querySelector("img")?.getAttribute("src") ?? ""),
            ),
          ),
      )
      .toBe(true);

    // --- Remove the copy, Undo: its photo comes back --------------------------
    await yourCopies.getByRole("button", { name: `Remove ${short}, Raw, Excellent`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(yourCopies.getByRole("img", { name: "Front of Raw, Excellent", exact: true })).toBeVisible();

    // --- Saving the line's other details keeps its photo ----------------------
    await yourCopies.getByRole("button", { name: `Edit ${short}, Raw, Excellent`, exact: true }).click();
    await form.getByRole("textbox", { name: "Notes" }).fill("corner ding");
    await form.getByRole("button", { name: "Save copy", exact: true }).click();
    await expect(form).toBeHidden();
    await expect(yourCopies.getByRole("img", { name: "Front of Raw, Excellent", exact: true })).toBeVisible();

    // --- Remove it for good (self-cleaning) ----------------------------------
    await yourCopies.getByRole("button", { name: `Remove ${short}, Raw, Excellent`, exact: true }).click();
    await expect(yourCopies.getByText("None yet. Fill in what you know below and add it.")).toBeVisible();
    await drawer.getByRole("button", { name: "Close card detail" }).click();
    await expect(drawer).toBeHidden();
    await expect(checklist.getByRole("button", { name: `Have ${short}`, exact: true, pressed: false })).toBeVisible();
  },
);
