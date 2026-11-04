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
// NEO-370: the closed run still holds the failed photo, so its Pairing column
// is not clear and leaving the page asks first (`useLeaveGuard`, a confirm).
// The spec answers Stay on an in-app tab link (the URL and the run stay), then
// Leave on the same link (the page moves). Back after that returns to the run.
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
    // The pressed button leaves with the photo; focus lands on the pile's heading,
    // not the page.
    const pairingHeading = page.getByRole("heading", { name: "Pairing" });
    await expect(pairingHeading).toBeFocused();

    // ...and it ends: read again, it fails again (there is no photo behind it),
    // and the pile says so and still offers another try. The old reason is gone
    // for good (the new one reads differently), which, unlike the button's few
    // moments out of the pile, is still true whenever this line runs.
    await expect(pairing.getByText("Took too long to read", { exact: true })).toHaveCount(0);
    await expect(pairing.getByText("Couldn't read it", { exact: true })).toBeVisible({ timeout: FAST_READ });
    await expect(pairing.getByRole("button", { name: `Try again: ${name}` })).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "0 saved. 1 photo couldn't be read." })).toHaveCount(1);

    // Two more tries use up the photo's three; the run is still open, but the
    // pile stops offering it and says what to do instead.
    //
    // Each press is told apart from the last by focus, not by the button's brief
    // absence: the photo is out of the pile only while it is read, and the fast
    // service answers "no such photo" in well under a second, so a wait for the
    // button to be gone can miss that window. The press starts on the button
    // (focus moves there), and focus returns to the pile's heading only when the
    // server took the retry and the photo has left the pile (the same update),
    // so the heading holding focus again is this round's press, which a stale
    // button or a press that did nothing cannot produce. The status line's
    // "Trying ... again." is not asserted here: it stays up for 10 s, so the
    // previous round's would satisfy it. Three presses against a cap of three
    // reach "Scan it again" only if each one was taken.
    for (let n = 2; n <= 3; n++) {
      const again = pairing.getByRole("button", { name: `Try again: ${name}` });
      await again.focus();
      await again.click();
      await expect(pairingHeading).toBeFocused();
      // The photo is out of the pile by now, so the last round's "Couldn't read it"
      // is gone and this wait is for this round's.
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

    // --- Leaving now asks: Stay keeps the run, Leave moves on ------------------
    const runUrl = page.url();
    const tabs = page.getByRole("navigation", { name: "Collection sections" });
    const myCards = tabs.getByRole("link", { name: "My Cards", exact: true });
    const asked: Array<{ type: string; message: string }> = [];
    page.once("dialog", (dialog) => {
      asked.push({ type: dialog.type(), message: dialog.message() });
      void dialog.dismiss();
    });
    await myCards.click();
    expect(asked).toHaveLength(1);
    expect(asked[0].type).toBe("confirm");
    expect(asked[0].message).toMatch(/^This run isn't finished: some cards are still working or need you\. Leave anyway\?/);
    // Stay: nothing moved. Same URL, same tab, and the unread photo is still in the pile.
    await expect(page).toHaveURL(runUrl);
    await expect(tabs.getByRole("link", { name: "Add cards", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(myCards).not.toHaveAttribute("aria-current", "page");
    await expect(pairing.getByText("Couldn't read it. Scan it again.", { exact: true })).toBeVisible();

    // Leave: the same link, answered yes, moves to My Cards.
    page.once("dialog", (dialog) => {
      asked.push({ type: dialog.type(), message: dialog.message() });
      void dialog.accept();
    });
    await myCards.click();
    expect(asked).toHaveLength(2);
    expect(asked[1].message).toBe(asked[0].message);
    await expect(myCards).toHaveAttribute("aria-current", "page");
    await expect(page).not.toHaveURL(/[?&]run=/);
    // Back is a step in the URL: it returns to the run (no question on the way back,
    // the guard belongs to the run's screen).
    await page.goBack();
    await expect(page).toHaveURL(runUrl);
    await expect(pairing.getByText("Couldn't read it. Scan it again.", { exact: true })).toBeVisible();
  },
);
