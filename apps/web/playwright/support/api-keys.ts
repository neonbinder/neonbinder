/**
 * NEO-459: make and revoke a Clerk API key through Profile -> API Keys, for a
 * spec that needs a real key (the scanner app signs in with one). The same
 * steps `profile/api-keys-create-copy-and-revoke` proves, as helpers.
 *
 * GUIDE hard rule 7: the secret is on screen from "Create key" to "Copy &
 * Close". Failure artifacts are published, so the window is wrapped to blank
 * the page on any failure, and a spec using this sets
 * `test.use({ screenshot: "off" })`. The secret is returned to the caller and
 * must stay in memory: never in a locator, a log line, an argument or a file.
 */
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Expires in a day, so a key a failed run could not revoke clears itself. */
export async function createApiKey(page: Page, keyName: string): Promise<string> {
  await page.getByRole("button", { name: "Add new key" }).click();
  await expect(page.getByRole("heading", { name: "Add new API key" })).toBeVisible();
  const create = page.getByRole("form", { name: "API key form" });
  await create.getByPlaceholder("Enter your secret key name").fill(keyName);
  await create.getByRole("button", { name: "Select date" }).click();
  // Clerk's select: its option label is not itself the hit target (the
  // wrapping row is), so a coordinate click is refused; the click event is
  // what the row handles.
  await page.getByText("1 Day", { exact: true }).dispatchEvent("click");
  await expect(create.getByText(/Expiring/)).toBeVisible();
  try {
    await create.getByRole("button", { name: "Create key" }).click();
    const reveal = page.getByRole("dialog").filter({ hasText: keyName });
    await expect(reveal.getByText(/Copy your.*API Key now/)).toBeVisible();
    // The secret sits in a read-only box, named "API key".
    const secret = await reveal.getByRole("textbox", { name: "API key" }).inputValue();
    expect(secret.length, "the revealed key is not empty").toBeGreaterThan(20);
    await reveal.getByRole("button", { name: "Copy & Close" }).click();
    await expect(reveal).toBeHidden();
    return secret;
  } catch (e) {
    await page.goto("about:blank").catch(() => {});
    throw e;
  }
}

/** Revoke the key made above (the page is on Profile -> API Keys), through the menu and the typed confirmation. */
export async function revokeApiKey(page: Page, keyName: string): Promise<void> {
  await page.getByPlaceholder("Search keys").fill(keyName);
  const row = page.getByRole("row").filter({ has: page.getByText(keyName, { exact: true }) });
  await expect(row).toBeVisible();
  // Clerk's <APIKeys/> re-renders its list (and the open row menu) while the
  // menu animates in, so a click can land on a detached item (CI run
  // 38229048524). Open the menu and choose Revoke as one unit, retried until
  // the confirm dialog shows, the way a user would just open it again.
  const revoke = page.getByRole("dialog").filter({ hasText: /Revoke.*secret key/ });
  await expect(async () => {
    if (!(await revoke.isVisible())) {
      await row.getByRole("button", { name: "Open menu" }).click({ timeout: 2_000 });
      await page.getByRole("menuitem", { name: "Revoke key" }).click({ timeout: 2_000 });
    }
    await expect(revoke).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 7_000 });
  await revoke.getByRole("textbox").fill("Revoke");
  await revoke.getByRole("button", { name: "Revoke key" }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("No API keys found")).toBeVisible();
}
