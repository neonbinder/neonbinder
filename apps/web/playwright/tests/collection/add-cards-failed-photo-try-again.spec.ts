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
// R5: the one wait past 7 s is the fast service's answer to the retried photo:
// a 404 answered at once, plus a cold fast instance's start (the fast service
// allows itself 60 s per call, PREPROCESS_FAST_TIMEOUT_MS), doubled for the
// queue. Every collector action runs at 7 s.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

/** The fast service's answer to a retried photo, cold start included. */
const FAST_READ = 120_000;

test(
  "Add cards from photos: a photo that was never read ends, says why, and Try again sends it through again",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    await signIn("/testing/seed-placeholder-run%3FfailedPhoto%3D1");

    // The photo sits in the pairing pile, failed, with the reason in words and
    // the run's status saying it was not read.
    const pairing = page.getByRole("region", { name: /^Pairing, \d+$/ });
    const retry = pairing.getByRole("button", { name: /^Try again: never-read-.*\.jpg$/ });
    // The launch gate: sign-in, the seed hop and the run screen's first load.
    await expect(retry).toBeVisible({ timeout: LAUNCH_GATE });
    await expect(page).toHaveURL(/\/collection\?tab=add&run=/);
    await expect(pairing.getByText("Took too long to read", { exact: true })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "0 saved. 1 photo couldn't be read." })).toHaveCount(1);
    await expectAccessible(page, { label: "Add cards, a photo that was never read" });

    // Try again, from the keyboard: the photo goes back to be read.
    const name = (await retry.getAttribute("aria-label"))!.replace(/^Try again: /, "");
    await retry.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("status").filter({ hasText: `Trying ${name} again.` })).toBeVisible();
    await expect(pairing.getByRole("button", { name: `Try again: ${name}` })).toHaveCount(0);
    // The pressed button leaves with the photo; focus lands on the pile's heading,
    // not the page.
    await expect(page.getByRole("heading", { name: "Pairing" })).toBeFocused();

    // ...and it ends: read again, it fails again (there is no photo behind it),
    // and the pile says so and still offers another try.
    await expect(pairing.getByText("Couldn't read it", { exact: true })).toBeVisible({ timeout: FAST_READ });
    await expect(pairing.getByRole("button", { name: `Try again: ${name}` })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "0 saved. 1 photo couldn't be read." })).toHaveCount(1);

    // Two more tries use up the photo's three; the run is still open, but the
    // pile stops offering it and says what to do instead.
    for (let n = 2; n <= 3; n++) {
      await pairing.getByRole("button", { name: `Try again: ${name}` }).click();
      await expect(page.getByRole("status").filter({ hasText: `Trying ${name} again.` })).toBeVisible();
      // Gone from the pile while it is read (the last round's "Couldn't read it"
      // must not satisfy this round's wait).
      await expect(pairing.getByRole("button", { name: `Try again: ${name}` })).toHaveCount(0);
      await expect(pairing.getByText(n < 3 ? "Couldn't read it" : "Couldn't read it. Scan it again.", { exact: true })).toBeVisible({
        timeout: FAST_READ,
      });
    }
    await expect(pairing.getByRole("button", { name: /^Try again: / })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Done adding photos" })).toBeVisible();

    // Close the run; a closed run offers no Try again and says what to do instead.
    await page.getByRole("button", { name: "Done adding photos" }).click();
    await expect(pairing.getByText("Couldn't read it. Scan it again.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Done adding photos" })).toHaveCount(0);
    await expectAccessible(page, { label: "Add cards, a closed run with a photo that was never read" });
  },
);
