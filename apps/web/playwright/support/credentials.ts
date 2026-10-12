/**
 * Marketplace session warm-ups — specs: .maestro/flows/util/util-login-to-bsc.yaml
 * and util-login-to-sportlots.yaml.
 *
 * Both open /profile/credentials, check the worker is CONNECTED (fail fast,
 * by name, if not), press "Test Credentials" and wait for the live login to
 * report success. Both leave the page on /profile/credentials.
 */
import { expect, type Page } from "@playwright/test";
import type { FlowEnv } from "./env";

/** A cold marketplace login is a real ~22 s Puppeteer/SSO round trip (the flows' 30 s). */
export const LIVE_LOGIN = 30_000;

async function openCredentials(page: Page): Promise<void> {
  await page.goto("/profile/credentials");
  // An in-session navigation, not a cold launch: the flows' 10 s.
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
    timeout: 10_000,
  });
}

async function testStoredSession(page: Page, success: RegExp): Promise<void> {
  // While another credential op holds the lock the button reads
  // "Testing..."; wait for the real label (the flows' 30 s).
  const test = page.getByRole("button", { name: "Test Credentials" });
  await expect(test).toBeVisible({ timeout: LIVE_LOGIN });
  await test.click();
  await expect(page.getByText(success)).toBeVisible({ timeout: LIVE_LOGIN });
}

/** util-login-to-bsc.yaml */
export async function loginToBsc(page: Page): Promise<void> {
  await openCredentials(page);
  // BuySportsCards is the default tab.
  await expect(page.getByText("Connected to BuySportsCards")).toBeVisible();
  await testStoredSession(page, /BSC account authenticated successfully/i);
}

/** util-login-to-sportlots.yaml — two branches on the operator's pause switch. */
export async function loginToSportLots(page: Page, env: FlowEnv): Promise<void> {
  await openCredentials(page);
  const tab = page.getByRole("tab", { name: "SportLots" });
  await expect(tab).toBeVisible({ timeout: 10_000 });
  await tab.click();

  if (!env.SL_PAUSED) {
    await expect(page.getByText("Connected to SportLots")).toBeVisible();
    await testStoredSession(page, /Sportlots account authenticated successfully/i);
    return;
  }

  // Paused: the panel says so, and offers none of the live controls.
  await expect(page.getByRole("heading", { name: "SportLots Credentials" })).toBeVisible();
  await expect(page.getByText("SportLots is on pause", { exact: true })).toBeVisible();
  await expect(page.getByText(/^Sign-ins to SportLots are benched for now/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Test Credentials" })).toBeHidden();
  await expect(page.getByLabel(/SportLots Username/i)).toBeHidden();
}
