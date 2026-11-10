/**
 * NEO-459: the Add cards screen's "Use a scanner" step, shared by the specs that
 * start a scanner run.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/**
 * Press "Use a scanner" on the open Add cards tab and read the six-character
 * code the panel shows, as a screen reader hears it, one character at a time.
 */
export async function startScannerRun(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Use a scanner" }).click();
  await expect(page).toHaveURL(/[?&]run=/);
  const panel = page.getByRole("group", { name: "Scanner code" });
  await expect(panel).toBeFocused();
  const spoken = panel.getByText(/^([A-HJ-NP-Z2-9] ){5}[A-HJ-NP-Z2-9]$/);
  return ((await spoken.textContent()) ?? "").replaceAll(" ", "");
}
