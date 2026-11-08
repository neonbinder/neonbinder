// NEO-459 (R1): Done ends the scanner session from either side. Pressing
// "Done adding photos" on the Add cards screen stops the NeonBinder Scanner app
// ("This run closed on NeonBinder.") and, with no keyboard to ask for another
// code, it leaves cleanly; pressing D in the app closes the run on the screen
// ("This run's photos are all in..."), takes the Done button away and, because
// the card it sent is still being read, leaving the page asks first.
//
// NEO-452: a run needs a set before anything starts, so each leg picks 2024
// Topps Chrome Base (`pickIntakeSet`) before "Use a scanner". NEO-446: a run that
// closes with no photo in it says so ("No photos came in...") rather than "all in".
//
// The app (apps/scanner) really runs here, as a child process of the spec, over
// a real Convex websocket (support/scanner-app.ts says how and what is stood in):
// a fake scanner on its PATH (apps/scanner/src/testing/fake-scanimage.sh), a Clerk
// API key made through Profile -> API Keys (support/api-keys.ts), the deployment
// under test named by the page itself. D is written to the child's stdin, a pipe:
// the app reads keys from any stream, and with no TTY it never asks for a code
// again, which is what makes "leaves cleanly" assertable.
//
// What the card proves and does not: the fake scanner hands over one card whose
// two pages are not images, so the app uploads them as it would any scan and the
// run holds them while they are read. The spec waits for the app's own "Card 1
// sent." and never for the read, which would be the heavy preprocess path (cold
// starts). A closed run with a card still being read is exactly what makes leaving
// ask first (`useLeaveGuard`), so the warning is reachable without that wait.
//
// R7: writes only the account's own two runs and one API key. The key expires in
// a day, and is revoked on the way out; each run is closed (by the spec's own
// press, by D, or in the cleanup) and the second one keeps the unread card, as
// `add-cards-failed-photo-try-again` does with its seeded photo.
//
// GUIDE hard rule 7: the key's secret is shown once; the file turns screenshots
// off and the reveal is wrapped to blank the page on failure (support/api-keys.ts).
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { createApiKey, revokeApiKey } from "../../support/api-keys";
import { convexUrlOf, startScannerApp, type ScannerApp } from "../../support/scanner-app";
import { startScannerRun } from "../../support/scanner-run";
import { pickIntakeSet } from "../../support/collection";

test.use({ screenshot: "off" });

/** What a run that closed with no photo in it says (`runNotice`, realLanes.ts). */
const NO_PHOTOS = "No photos came in before this run closed. Start a new run and drop some in.";

/**
 * The run's line once D has closed it with the card in (`runNotice`, realLanes.ts).
 * Two pages that are not images: "all in" while they are being read, and the
 * failed batch's line if both reads gave up before the close landed. The spec
 * waits on neither read (see the top), so either is the closed run.
 */
const CLOSED_WITH_CARD = /^(This run's photos are all in\. To add more, start a new run\.|Most of these photos wouldn't read\.)/;

test(
  "Scanner app: Done on the screen ends the app, and D in the app closes the run on the screen",
  { tag: ["@collection"] },
  async ({ page, signIn, env }) => {
    const keyName = `scan${env.ATTEMPT_TOKEN}`;
    const apps: ScannerApp[] = [];
    let keyMade = false;
    let passed = false;
    try {
      await signIn("/profile/api-keys");
      await expect(page.getByRole("button", { name: "Add new key" })).toBeVisible({ timeout: LAUNCH_GATE });
      const apiKey = await createApiKey(page, keyName);
      keyMade = true;
      const convexUrl = await convexUrlOf(page);

      const openAddCards = async () => {
        await page.goto("/collection?tab=add");
        await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible();
        await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });
        await pickIntakeSet(page);
      };

      // --- Done on the screen -> the app ----------------------------------------
      await openAddCards();
      const code = await startScannerRun(page);
      const first = await startScannerApp({ code, apiKey, convexUrl });
      apps.push(first);
      await first.said("Joined: cards go into Main");
      await first.said("Ready. Load cards in the feeder");

      await page.getByRole("button", { name: "Done adding photos" }).click();
      await expect(page.getByText(NO_PHOTOS)).toBeVisible();
      await first.said("This run closed on NeonBinder. 0 cards sent.");
      // No keyboard to ask for another code: it leaves, cleanly.
      expect(await first.exited()).toBe(0);
      expect(first.output()).not.toMatch(/Done\.|Couldn't reach|didn't reach/);

      // --- D in the app -> the screen -------------------------------------------
      await openAddCards();
      const second = await startScannerRun(page);
      expect(second).not.toBe(code);
      const withCard = await startScannerApp({ code: second, apiKey, convexUrl, cards: 1 });
      apps.push(withCard);
      await withCard.said("Joined: cards go into Main");
      // The card goes up front then back, then the app says so.
      await withCard.said("Card 1 sent.");
      // Both sides of the card are in the run, in the lane they are being read in
      // (or, once the read gives up on a page that is not an image, in the pile).
      await expect(page.getByRole("region", { name: /^(Cropping & reading|Pairing), 2$/ })).toBeVisible();
      await expect(page.getByRole("button", { name: "Done adding photos" })).toBeVisible();

      withCard.press("d");
      await withCard.said("Done. 1 card sent.");
      // The screen follows with nobody touching it: the run is closed, Done is gone.
      await expect(page.getByText(CLOSED_WITH_CARD)).toBeVisible();
      await expect(page.getByRole("button", { name: "Done adding photos" })).toHaveCount(0);
      await expect(page.getByRole("status").filter({ hasText: "That's a wrap on this run's photos!" })).toBeVisible();
      expect(await withCard.exited()).toBe(0);
      await expectAccessible(page, { label: "Add cards, a run the scanner app closed" });

      // The card is still being read, so leaving asks first. Stay keeps the run...
      const runUrl = page.url();
      const tabs = page.getByRole("navigation", { name: "Collection sections" });
      const myCards = tabs.getByRole("link", { name: "My Cards", exact: true });
      const asked: string[] = [];
      page.once("dialog", (dialog) => {
        asked.push(`${dialog.type()}: ${dialog.message()}`);
        void dialog.dismiss();
      });
      await myCards.click();
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(/^confirm: This run isn't finished: some cards are still working or need you\. Leave anyway\?/);
      await expect(page).toHaveURL(runUrl);
      await expect(page.getByText(CLOSED_WITH_CARD)).toBeVisible();
      // ...and Leave moves on (which also frees the page for the cleanup below).
      page.once("dialog", (dialog) => void dialog.accept());
      await myCards.click();
      await expect(myCards).toHaveAttribute("aria-current", "page");
      await expect(page).not.toHaveURL(/[?&]run=/);
      passed = true;
    } finally {
      const undone: string[] = [];
      for (const app of apps) await app.stop().catch((e: unknown) => undone.push(`stopping the scanner app: ${String(e)}`));
      // A run still taking cards must not hold the account's active-batch slot.
      try {
        const done = page.getByRole("button", { name: "Done adding photos" });
        if (page.url().includes("run=") && (await done.isVisible())) {
          await done.click();
          // Leave only once the close has landed, or the page goes with it in flight.
          // Either leg can get here, with no photo in or with the card.
          await expect(page.getByText(CLOSED_WITH_CARD).or(page.getByText(NO_PHOTOS))).toBeVisible();
        }
      } catch (e) {
        undone.push(`closing the open run: ${e instanceof Error ? e.message.split("\n").filter(Boolean).slice(0, 3).join(" ") : String(e)}`);
      }
      if (keyMade) {
        try {
          await page.goto("/profile/api-keys");
          await expect(page.getByRole("button", { name: "Add new key" })).toBeVisible();
          await revokeApiKey(page, keyName);
        } catch (e) {
          undone.push(`revoking ${keyName}: ${e instanceof Error ? e.message.split("\n").filter(Boolean).slice(0, 3).join(" ") : String(e)}`);
        }
      }
      // A failure above is the report; a clean body must leave nothing behind.
      if (passed && undone.length) throw new Error(`Left undone: ${undone.join("; ")}`);
    }
  },
);
