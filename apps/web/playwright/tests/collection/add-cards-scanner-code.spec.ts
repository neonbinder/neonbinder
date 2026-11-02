// NEO-386 (R1): "Use a scanner" on Add cards. With no run open it starts one
// (an empty scanner session filing into the binder or box picked), moves focus
// to the six-character code the scanner app joins it with, copies it on
// Copy code, and links the app's Mac downloads. The run lives on the URL, so
// after a reload asking again gives the same code. "Done adding photos" closes
// the empty session. Both sides: the Collection files into a binder, the
// Inventory into a box (its own Main, which every account has).
//
// The app itself (apps/scanner) needs a real scanner and a real API key,
// so its side of the join is pinned in convex/intakeScanner.test.ts,
// convex/scannerContract.test.ts and apps/scanner's unit tests, not here.
//
// R7: writes only the account's own runs. Each is closed before the leg ends,
// and again on the way out if a step failed, so an empty session never holds
// one of the account's two active-batch slots for its 30-minute idle window.
import type { Page } from "@playwright/test";
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

/** Start a scanner run from the open Add cards tab; returns the code shown. */
async function useScanner(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Use a scanner" }).click();
  await expect(page).toHaveURL(/[?&]run=/);
  const panel = page.getByRole("group", { name: "Scanner code" });
  await expect(panel).toBeFocused();
  await expect(panel.getByRole("link", { name: "Apple chip" })).toHaveAttribute("href", /scanner-mac-arm64\.zip$/);
  await expect(panel.getByRole("link", { name: "Intel chip" })).toHaveAttribute("href", /scanner-mac-x64\.zip$/);
  // The code as a screen reader hears it, one character at a time.
  const spoken = panel.getByText(/^([A-HJ-NP-Z2-9] ){5}[A-HJ-NP-Z2-9]$/);
  const code = ((await spoken.textContent()) ?? "").replaceAll(" ", "");
  // Copy code puts the bare code on the clipboard. Clipboard permission
  // differs per browser engine, so the write is captured rather than read back.
  await page.evaluate(() => {
    const w = window as unknown as { copied?: string };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void (w.copied = text) },
    });
  });
  await panel.getByRole("button", { name: "Copy code" }).click();
  await expect(panel.getByRole("status")).toHaveText("Scanner code copied. Paste it into NeonBinder Scanner.");
  expect(await page.evaluate(() => (window as unknown as { copied?: string }).copied)).toBe(code);
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
      const code = await useScanner(page);
      await expectAccessible(page, { label: "Scanner code shown" });

      // The same run after a reload: asking again gives the same code.
      // A reload is a fresh launch: wait under the launch gate for the open
      // run itself to be back (its "Done adding photos"), not just the page
      // heading. Clicked before the run and binder load, Use a scanner has
      // neither and says "Make a binder first" (CI run 41383411397, phone).
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Collection" })).toBeVisible({ timeout: LAUNCH_GATE });
      await expect(page.getByRole("button", { name: "Done adding photos" })).toBeVisible({ timeout: LAUNCH_GATE });
      await page.getByRole("button", { name: "Use a scanner" }).click();
      await expect(page.getByRole("group", { name: "Scanner code" }).getByText(code.split("").join(" "))).toHaveCount(1);

      // Done with no photos: the empty session closes, quietly.
      await page.getByRole("button", { name: "Done adding photos" }).click();
      await expect(page.getByText("This run's photos are all in. To add more, start a new run.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Use a scanner" })).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expectAccessible(page, { label: "Scanner run closed" });

      // --- Inventory: into a box ---------------------------------------------------
      await page.goto("/inventory?tab=add");
      await expect(page.getByRole("combobox", { name: "Put them in this box" })).toBeVisible();
      const boxCode = await useScanner(page);
      expect(boxCode).not.toBe(code);
      await page.getByRole("button", { name: "Done adding photos" }).click();
      await expect(page.getByText("This run's photos are all in. To add more, start a new run.")).toBeVisible();
    } finally {
      await closeRun(page);
    }
  },
);
