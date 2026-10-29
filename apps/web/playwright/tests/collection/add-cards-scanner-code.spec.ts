// NEO-386 (R1): "Use a scanner" on Add cards. With no run open it starts one
// (an empty scanner session filing into the binder or box picked), moves focus
// to the six-character code the scanner script joins it with, and shows the
// command to run. The run lives on the URL, so after a reload asking again
// gives the same code. "Done adding photos" closes the empty session. Both
// sides: the Collection files into a binder, the Inventory into a box (its
// own Main, which every account has).
//
// The script itself (apps/scanner) needs a real scanner and a real API key,
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
  const command = panel.getByText(/^npm run scan [A-HJ-NP-Z2-9]{6}$/);
  await expect(command).toBeVisible();
  return ((await command.textContent()) ?? "").replace("npm run scan ", "");
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
      await page.reload();
      await page.getByRole("button", { name: "Use a scanner" }).click();
      await expect(page.getByRole("group", { name: "Scanner code" }).getByText(`npm run scan ${code}`)).toBeVisible();

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
