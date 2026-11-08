// NEO-446 (R1): a loose photo over the 64 megapixel limit says so. Dropped on
// its own, a flat 8200x8200 JPEG (67.24 MP, 395 KB) goes up like any photo, is
// turned away by the preprocess service, and lands in the Pairing pile with the
// line "Too big (over 64 megapixels). Shrink it and send it again." and no Try
// again button (the same bytes can only fail the same way), but a Set aside
// button. Once the run is closed ("Done adding photos") leaving it asks, because
// the pile is not clear; set aside, the pile is clear, the run reads as finished,
// the photo is listed under Set aside in the Saved lane, and leaving no longer
// asks. Back returns to the run, and Bring back puts the photo in Pairing again.
//
// Fixture: `fixtures/intake/over-limit/flat-67mp.jpg` (README beside it has the
// generation command). 67 MP is over the limit on the old 50 MP service and the
// new 65 MP one alike, so this spec does not depend on which preprocess build the
// deployment points at.
//
// NEO-452: a drop waits in the browser until the run has a set, so the run is set
// up first (Main, then the seed's 2024 Topps Chrome Base through `pickIntakeSet`)
// and the photo then goes up at once. The photo is turned away before it is read,
// so the set is only the run's home, never read against.
//
// R7/R7a: reads the seed's 2024 Topps Chrome Base only to pick it as the run's set
// (SET-REGISTRY.md, read-only consumers) and writes only the account's own open run
// (nothing is saved, no set or card is touched). The run is an open upload session,
// which holds one of the account's active-batch slots, so it is closed ("Done
// adding photos") mid-test and again on the way out if a step failed before that.
//
// R3: the set pick and the drop zone through `support/collection.ts`.
//
// R5 (hard rule 3): every wait is the normal 7 s except ONE, the "Too big" line
// appearing on the photo's tile (`COLD_REFUSAL`, below), which carries a signed-off
// ceiling. Measured on a warm dev service: upload 0.8-1.3 s, refusal 0.8 s. The
// preprocess legs are wrapped in `test.step`, so the report carries each leg's own
// duration.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { intakeDropzone, pickIntakeSet } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

/**
 * The one signed-off ceiling in this spec (GUIDE hard rule 3): 45 s, Jason, 2026-11-06.
 * It covers ONLY the wait for the "Too big" line on the photo's tile. Measured on CI's
 * desktop pass: about 27 s from the upload confirmed to the refusal, of which the
 * service's own answer took 409 ms; the rest was queueing behind other photos on a
 * cold fast service. It is void if a cold start is measured over 45 s, and never a
 * licence for any other wait in this spec.
 */
const COLD_REFUSAL = 45_000;

const PHOTO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "intake",
  "over-limit",
  "flat-67mp.jpg",
);
/** How every control names the photo (its file name). */
const NAME = "flat-67mp.jpg";

/** `failedText` for a photo over the pixel limit (`PHOTO_TOO_BIG_LINE`). */
const TOO_BIG = "Too big (over 64 megapixels). Shrink it and send it again.";

test(
  "Add cards: a photo over the size limit says it is too big, offers no Try again, and can be set aside and brought back",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    try {
      await signIn("/collection?tab=add");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
      await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });
      // NEO-452: the run needs its set before a drop goes up.
      await pickIntakeSet(page);

      // --- Drop the photo: it is sent, and the run starts on the URL ---------------
      await test.step("upload: photo dropped to the Sent 1 photo line", async () => {
        await intakeDropzone(page).setInputFiles(PHOTO);
        await expect(page.getByRole("status").filter({ hasText: "Sent 1 photo." })).toBeVisible();
      });

      await expect(page).toHaveURL(/[?&]run=/);
      const runUrl = page.url();

      // --- The pile says why, in words ------------------------------------------------
      const pairing = (n: number) => page.getByRole("region", { name: `Pairing, ${n}`, exact: true });

      await test.step("refusal: Sent line to the Too big line on the photo's tile", async () => {
        await expect(pairing(1).getByText(TOO_BIG, { exact: true })).toBeVisible({ timeout: COLD_REFUSAL });
      });

      // No Try again: the same bytes can only fail the same way. Set aside is there.
      // `exact`: "Set aside" is also the heading of the list it lands in.
      await expect(page.getByRole("button", { name: /^Try again: / })).toHaveCount(0);
      await expect(pairing(1).getByRole("button", { name: `Set aside ${NAME}`, exact: true })).toBeVisible();
      await expectAccessible(page, { label: "Add cards, a photo over the size limit" });

      // --- Closed, the pile is not clear, so leaving asks ------------------------------
      await page.getByRole("button", { name: "Done adding photos" }).click();
      await expect(page.getByRole("button", { name: "Done adding photos" })).toHaveCount(0);
      const asked: string[] = [];
      page.on("dialog", (dialog) => {
        asked.push(dialog.message());
        void dialog.dismiss();
      });
      const tabs = page.getByRole("navigation", { name: "Collection sections" });
      const myCards = tabs.getByRole("link", { name: "My Cards", exact: true });
      await myCards.click();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(/^This run isn't finished: some cards are still working or need you\. Leave anyway\?/);
      // Stay: the run, its URL and the photo are where they were.
      await expect(page).toHaveURL(runUrl);
      await expect(pairing(1).getByText(TOO_BIG, { exact: true })).toBeVisible();

      // --- Set aside: the run reads as finished and the photo is listed ------------------
      await pairing(1).getByRole("button", { name: `Set aside ${NAME}`, exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: `Set aside ${NAME}.` })).toBeVisible();
      await expect(pairing(0)).toBeVisible();
      for (const column of ["Cropping & reading", "Matching", "Needs you"]) {
        await expect(page.getByRole("region", { name: `${column}, 0`, exact: true })).toBeVisible();
      }
      const saved = page.getByRole("region", { name: /^Saved, \d+$/ });
      await expect(saved).toHaveAccessibleName("Saved, 0");
      await expect(saved.getByRole("heading", { name: "Set aside", exact: true })).toBeVisible();
      await expect(saved.getByRole("button", { name: `Bring back ${NAME}`, exact: true })).toBeVisible();
      await expectAccessible(page, { label: "Add cards, a too-big photo set aside" });

      // --- Clear, leaving no longer asks ---------------------------------------------------
      await myCards.click();
      await expect(myCards).toHaveAttribute("aria-current", "page");
      await expect(page).not.toHaveURL(/[?&]run=/);
      expect(asked).toHaveLength(1);

      // --- Back is a step in the URL; Bring back returns the photo to Pairing -----------------
      await page.goBack();
      await expect(page).toHaveURL(runUrl);
      await page.getByRole("region", { name: /^Saved, \d+$/ }).getByRole("button", { name: `Bring back ${NAME}`, exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: `Brought back ${NAME}.` })).toBeVisible();
      await expect(pairing(1).getByText(TOO_BIG, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /^Try again: / })).toHaveCount(0);
      await expectAccessible(page, { label: "Add cards, the too-big photo brought back" });
    } finally {
      const done = page.getByRole("button", { name: "Done adding photos" });
      if (await done.isVisible()) await done.click();
    }
  },
);
