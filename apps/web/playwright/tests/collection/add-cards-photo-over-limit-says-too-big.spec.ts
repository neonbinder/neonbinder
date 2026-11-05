// NEO-446 (R1): a loose photo over the 64 megapixel limit says so. Dropped on
// its own, a flat 8200x8200 JPEG (67.24 MP, 395 KB) goes up like any photo, is
// turned away by the preprocess service, and lands in the Pairing pile with the
// line "Too big (over 64 megapixels). Shrink it and send it again." and no Try
// again button (the same bytes can only fail the same way).
//
// Fixture: `fixtures/intake/over-limit/flat-67mp.jpg` (README beside it has the
// generation command). 67 MP is over the limit on the old 50 MP service and the
// new 65 MP one alike, so this spec does not depend on which preprocess build the
// deployment points at.
//
// R7: writes only the account's own open run (nothing is saved, no set or card is
// touched). The run is an open upload session, which holds one of the account's
// active-batch slots, so it is closed ("Done adding photos") before the test ends
// and again on the way out if a step failed.
//
// R5: the waits past 7 s are the pipeline's own exception (support/pipeline-wait.ts):
// the photo's upload leg and the service's answer. Everything a collector does
// runs at 7 s.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { PIPELINE, measuredWait } from "../../support/pipeline-wait";

const PHOTO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "fixtures",
  "intake",
  "over-limit",
  "flat-67mp.jpg",
);

/** `failedText` for a photo over the pixel limit (`PHOTO_TOO_BIG_LINE`). */
const TOO_BIG = "Too big (over 64 megapixels). Shrink it and send it again.";

test(
  "Add cards: a photo over the size limit says it is too big and offers no Try again",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    try {
      await signIn("/collection?tab=add");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
      await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });

      // --- Drop the photo: it is sent, and the run starts on the URL ---------------
      const dropped = Date.now();
      await page.getByLabel("Drag your card photos here, or browse your files").setInputFiles(PHOTO);
      // Sending is the pipeline's upload leg: its exception.
      await expect(page.getByRole("status").filter({ hasText: "Sent 1 photo." })).toBeVisible({ timeout: PIPELINE });
      measuredWait("upload: photo dropped to the Sent 1 photo line", dropped);
      await expect(page).toHaveURL(/[?&]run=/);

      // --- The pile says why, in words ------------------------------------------------
      const pairing = page.getByRole("region", { name: /^Pairing, \d+$/ });
      const sent = Date.now();
      // The service turns the photo away: the pipeline's exception.
      await expect(pairing.getByText(TOO_BIG, { exact: true })).toBeVisible({ timeout: PIPELINE });
      measuredWait("refusal: Sent line to the Too big line on the photo's tile", sent);
      // No Try again: the same bytes can only fail the same way.
      await expect(page.getByRole("button", { name: /^Try again: / })).toHaveCount(0);
      await expectAccessible(page, { label: "Add cards, a photo over the size limit" });
    } finally {
      const done = page.getByRole("button", { name: "Done adding photos" });
      if (await done.isVisible()) await done.click();
    }
  },
);
