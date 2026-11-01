// NEO-411 (R1): a photo that never got read ends, says why, and can be sent
// again. Before NEO-411 a photo the heavy service never answered kept the run
// on "Working on your photos." for as long as the retry ladder ran (up to ~48
// minutes); now it fails at a deadline and the pile offers Try again.
//
// The never-answered photo is seeded rather than produced (/testing/
// seed-placeholder-run?failedPhoto=1, `seedMyTestFailedPhotoRun`): making the
// heavy service miss on cue would cost minutes of real model time and could not
// be made certain. Nothing was uploaded under the seeded photo's key, so Try
// again runs the real retry path and the fast service answers "no such photo"
// at once: the photo leaves the failed state, is read again, and ends failed a
// second time. That second end is the property under test: it ends.
//
// R7: writes only the account's own run (the seed cancels the account's open
// runs first, for the active-run cap) and Main, which it reads but never
// writes a copy into. Self-cleaning: the run is closed at the end
// ("Done adding photos").
//
// R5: the one wait past 7 s is the fast service's answer to the retried photo
// (a cold fast instance can take a minute to start); every collector action
// runs at 7 s.
import { test, expect, expectAccessible } from "../../support/fixtures";

/** The fast service's answer to a retried photo, cold start included. */
const FAST_READ = 120_000;

test(
  "Add cards from photos: a photo that was never read ends, says why, and Try again sends it through again",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    await signIn("/testing/seed-placeholder-run%3FfailedPhoto%3D1");
    await expect(page).toHaveURL(/\/collection\?tab=add&run=/, { timeout: 30_000 });

    // The photo sits in the pairing pile, failed, with the reason in words and
    // the run's status saying it was not read.
    const pairing = page.getByRole("region", { name: /^Pairing, \d+$/ });
    const retry = pairing.getByRole("button", { name: /^Try again: never-read-.*\.jpg$/ });
    await expect(retry).toBeVisible({ timeout: 15_000 });
    await expect(pairing.getByText("Took too long to read", { exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "0 saved. 1 photo couldn't be read." })).toHaveCount(1);
    await expectAccessible(page, { label: "Add cards, a photo that was never read" });

    // Try again, from the keyboard: the photo goes back to be read.
    const name = (await retry.getAttribute("aria-label"))!.replace(/^Try again: /, "");
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: `Trying ${name} again.` })).toBeVisible();

    // ...and it ends: read again, it fails again (there is no photo behind it),
    // and the pile says so and still offers another try.
    await expect(pairing.getByText("Couldn't read it", { exact: true })).toBeVisible({ timeout: FAST_READ });
    await expect(pairing.getByRole("button", { name: `Try again: ${name}` })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "0 saved. 1 photo couldn't be read." })).toHaveCount(1);

    // Close the run; a closed run offers no Try again and says what to do instead.
    await page.getByRole("button", { name: "Done adding photos" }).click();
    await expect(pairing.getByText("Couldn't read it. Scan it again.", { exact: true })).toBeVisible();
    await expect(pairing.getByRole("button", { name: /^Try again: / })).toHaveCount(0);
  },
);
