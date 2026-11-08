// NEO-386 (R1): "Use a scanner" on Add cards. With no run open it starts one
// (an empty scanner session filing into the binder or box picked), moves focus
// to the six-character code the scanner app joins it with, and links the app's
// Mac downloads. The run lives on the URL, so after a reload asking again gives
// the same code. "Done adding photos" closes the empty session, and the run says
// so (NEO-446): a run that closed with no photo in it failed, so the screen says
// "No photos came in before this run closed" and offers "Start a new run" rather
// than claiming the photos are all in. Both sides: the Collection files into a
// binder, the Inventory into a box (its own Main, which every account has).
//
// NEO-459: the click itself copies the code and the panel says so ("Scanner
// code copied. Paste it into NeonBinder Scanner."); the copy icon ("Copy scanner
// code") copies it again. A browser that refuses the clipboard gets a plain
// line saying to press the copy icon or type the code, and no alert.
//
// NEO-416: a photo dropped while the shelf and the ?run= run are still loading
// is queued and sent into that same run once they load (never "Make a binder
// first", never a new run). That half is proven by unit tests: the loading
// window cannot be targeted live, and the photo specs drive real preprocess.
//
// NEO-452: a run needs a set before anything starts, so "Use a scanner" is held
// ("Pick a set first, then get a code.") until one is picked, on both sides.
// Each section picks 2024 Topps Chrome Base first (`pickIntakeSet`); the held
// button is asserted once, on the Collection side.
//
// The app's side of the join, and of Done, is driven live by
// scanner-app-done-both-ways.spec.ts. Its wire contract is also pinned in
// convex/intakeScanner.test.ts and convex/scannerContract.test.ts.
//
// R7: writes only the account's own runs. Each is closed before the leg ends,
// and again on the way out if a step failed, so an empty session never holds
// one of the account's two active-batch slots for its 30-minute idle window.
import type { Locator, Page } from "@playwright/test";
import { pickIntakeSet } from "../../support/collection";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";
import { startScannerRun } from "../../support/scanner-run";

/**
 * Stand in for the browser's clipboard, so the write is captured rather than
 * read back (permission differs per engine). "capture" keeps what either API
 * is given, reading a ClipboardItem's text the way a paste would; "refuse"
 * rejects both, the way a browser that denies the page does.
 */
async function stubClipboard(page: Page, mode: "capture" | "refuse") {
  await page.evaluate((m) => {
    const w = window as unknown as { copied?: string };
    w.copied = undefined;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value:
        m === "refuse"
          ? {
              write: async () => Promise.reject(new DOMException("denied", "NotAllowedError")),
              writeText: async () => Promise.reject(new DOMException("denied", "NotAllowedError")),
            }
          : {
              write: async (items: ClipboardItem[]) => {
                const blob = await items[0].getType("text/plain");
                w.copied = await blob.text();
              },
              writeText: async (text: string) => void (w.copied = text),
            },
    });
  }, mode);
}

const captured = (page: Page) => page.evaluate(() => (window as unknown as { copied?: string }).copied);

/** The panel's one visible line about the clipboard (the panel holds two status regions). */
const clipLine = (panel: Locator, text: string | RegExp) => panel.getByRole("status").filter({ hasText: text });

const COPIED = "Scanner code copied. Paste it into NeonBinder Scanner.";

/** What a run that closed with no photo in it says (`runNotice`, realLanes.ts). */
const NO_PHOTOS = "No photos came in before this run closed. Start a new run and drop some in.";

/** Start a scanner run from the open Add cards tab; returns the code shown. */
async function useScanner(page: Page): Promise<string> {
  // The clipboard is stubbed BEFORE the click: Use a scanner copies the code itself.
  await stubClipboard(page, "capture");
  const code = await startScannerRun(page);
  const panel = page.getByRole("group", { name: "Scanner code" });
  await expect(panel.getByRole("link", { name: "Apple chip" })).toHaveAttribute("href", /scanner-mac-arm64\.zip$/);
  await expect(panel.getByRole("link", { name: "Intel chip" })).toHaveAttribute("href", /scanner-mac-x64\.zip$/);

  // The click copied the bare code and the panel says so once it has focus.
  await expect(clipLine(panel, COPIED)).toBeVisible();
  expect(await captured(page)).toBe(code);

  // The copy icon copies it again: clear the capture, press, and see both.
  await stubClipboard(page, "capture");
  expect(await captured(page)).toBeUndefined();
  await panel.getByRole("button", { name: "Copy scanner code" }).click();
  await expect.poll(() => captured(page)).toBe(code);
  await expect(clipLine(panel, COPIED)).toBeVisible();
  return code;
}

/** Close the open run if it is still taking cards (cleanup on any path). */
async function closeRun(page: Page) {
  const done = page.getByRole("button", { name: "Done adding photos" });
  if (await done.isVisible()) await done.click();
}

test(
  "Add cards: Use a scanner starts a run and shows the code the scanner joins with",
  { tag: ["@collection"] },
  async ({ page, signIn }) => {
    try {
      // --- Collection: into a binder ---------------------------------------------
      await signIn("/collection?tab=add");
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
      await page.getByRole("combobox", { name: "Put them in this binder" }).selectOption({ label: "Main" });
      // No set yet: the scanner button stays on screen, held, and says why.
      const scannerButton = page.getByRole("button", { name: "Use a scanner" });
      await expect(page.getByRole("button", { name: "Set: pick one" })).toBeVisible();
      await expect(scannerButton).toBeDisabled();
      await expect(scannerButton).toHaveAccessibleDescription(/Pick a set first, then get a code\./);
      await expectAccessible(page, { label: "Add cards, Use a scanner held until a set is picked" });
      await pickIntakeSet(page);
      const code = await useScanner(page);
      await expectAccessible(page, { label: "Scanner code shown" });

      // The same run after a reload: asking again gives the same code.
      // A reload is a fresh launch (R4: gate on the destination's heading under
      // the launch gate). Use a scanner is aria-disabled while the binders and
      // the open run load (NEO-416), so the button is only offered once they
      // are back and asking neither says "Make a binder first" nor starts a
      // second run: it answers with the open run's code. Waiting for the
      // enabled button is the cold-launch gate (R4); the click then runs at 7 s.
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
      await expect(page.getByRole("button", { name: "Use a scanner", disabled: false })).toBeVisible({ timeout: LAUNCH_GATE });
      // This browser refuses the clipboard: the panel says to press the copy
      // icon or type the code, as plain words and not an alert.
      await stubClipboard(page, "refuse");
      await page.getByRole("button", { name: "Use a scanner" }).click();
      const again = page.getByRole("group", { name: "Scanner code" });
      await expect(again.getByText(code.split("").join(" "))).toHaveCount(1);
      await expect(clipLine(again, /^No auto-copy this time\..*type the code/)).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);

      // Done with no photos: the empty session closes as a failed run (nothing came
      // in), and says so with the way forward (NEO-446).
      await page.getByRole("button", { name: "Done adding photos" }).click();
      await expect(page.getByText(NO_PHOTOS)).toBeVisible();
      await expect(page.getByRole("button", { name: "Start a new run", exact: true })).toBeVisible();
      await expect(page.getByText("This run's photos are all in")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Use a scanner" })).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expectAccessible(page, { label: "Scanner run closed" });

      // --- Inventory: into a box ---------------------------------------------------
      await page.goto("/inventory?tab=add");
      await expect(page.getByRole("combobox", { name: "Put them in this box" })).toBeVisible();
      await pickIntakeSet(page);
      const boxCode = await useScanner(page);
      expect(boxCode).not.toBe(code);
      await page.getByRole("button", { name: "Done adding photos" }).click();
      await expect(page.getByText(NO_PHOTOS)).toBeVisible();
    } finally {
      await closeRun(page);
    }
  },
);
