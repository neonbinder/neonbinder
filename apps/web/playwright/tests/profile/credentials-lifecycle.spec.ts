// Origin: .maestro/flows/profile/credentials-lifecycle.yaml (Maestro suite retired in NEO-341; see git history)
// Isolated "new-profile" account. Per platform: connect real creds (seeded),
// test, clear, then a rejected sign-in with fake creds (nothing saved: the
// sign-in form is still showing), re-connect real creds, test, clear.
import type { Page } from "@playwright/test";
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

const SEED_BUDGET = 90_000; // seed-credentials performs a real marketplace sign-in
const LIVE = 30_000; // live marketplace round trip
const REJECTED = 120_000; // a rejected live sign-in

async function seedAndOpen(page: Page, site: string, label: string): Promise<void> {
  await page.goto(`/testing/seed-credentials?sites=${site}&redirect=/profile/credentials`);
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
    timeout: SEED_BUDGET,
  });
  await selectSite(page, label);
}

async function selectSite(page: Page, label: string): Promise<void> {
  // BuySportsCards is the default tab; SportLots needs a click.
  if (label === "SportLots") {
    await page.getByRole("tab", { name: "SportLots" }).click();
  }
  await expect(page.getByRole("heading", { name: `${label} Credentials` })).toBeVisible();
}

async function testStoredSession(page: Page, label: string, success: RegExp): Promise<void> {
  await expect(page.getByText(`Connected to ${label}`)).toBeVisible();
  const testButton = page.getByRole("button", { name: "Test Credentials" });
  await expect(testButton).toBeVisible({ timeout: LIVE });
  await testButton.click();
  await expect(page.getByText(success)).toBeVisible({ timeout: LIVE });
}

async function clearConnection(page: Page, label: string): Promise<void> {
  const clear = page.getByRole("button", { name: "Clear Credentials" });
  await expect(clear).toBeVisible({ timeout: LIVE });
  await clear.click();
  await page.getByRole("button", { name: "Yes, Clear" }).click();
  await expect(page.getByText(`Cleared your ${label} connection.`)).toBeVisible({ timeout: LIVE });
}

async function failedSignIn(
  page: Page,
  label: string,
  user: string,
  pass: string,
  rejection: RegExp,
): Promise<void> {
  const username = page.getByLabel(new RegExp(`${label} Username`));
  await expect(username).toBeVisible({ timeout: LIVE });
  await username.fill(user);
  await page.getByLabel(new RegExp(`${label} Password`)).fill(pass);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(rejection)).toBeVisible({ timeout: REJECTED });
  // Nothing was saved: the form only renders while the account is unconnected.
  await expect(username).toBeVisible();
}

test(
  "Credentials lifecycle — connect, rejected sign-in, recover, clear (BSC + SportLots)",
  { tag: ["@credentials", "@profile"] },
  async ({ page, signIn, env }) => {
    await signIn("/profile/credentials", { account: "new-profile" });
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
      timeout: LAUNCH_GATE,
    });

    // ---- BuySportsCards ----
    const bsc = "BuySportsCards";
    await seedAndOpen(page, "buysportscards", bsc);
    await testStoredSession(page, bsc, /BSC account authenticated successfully/);
    await clearConnection(page, bsc);

    await failedSignIn(
      page,
      bsc,
      "e2e-fake-bsc-user",
      "e2e-fake-bsc-pass",
      /Could not sign in to BuySportsCards.*Nothing was saved/s,
    );

    // Recover: re-connect real creds and prove the session works.
    await seedAndOpen(page, "buysportscards", bsc);
    await testStoredSession(page, bsc, /BSC account authenticated successfully/);

    // A fresh load still shows the connection; clear it for good.
    await page.goto("/profile/credentials");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
      timeout: LIVE,
    });
    await expect(page.getByRole("heading", { name: `${bsc} Credentials` })).toBeVisible({
      timeout: LIVE,
    });
    await clearConnection(page, bsc);
    await expect(page.getByLabel(/BuySportsCards Username/)).toBeVisible();

    // ---- SportLots ----
    const sl = "SportLots";
    if (!env.SL_PAUSED) {
      await seedAndOpen(page, "sportlots", sl);
      await testStoredSession(page, sl, /SportLots account authenticated successfully/i);
      await clearConnection(page, sl);

      await page.goto("/profile/credentials");
      await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
        timeout: LIVE,
      });
      await selectSite(page, sl);
      // NEO-288: SportLots refuses the sign-in site-side.
      await failedSignIn(
        page,
        sl,
        "e2e-fake-sl-user",
        "e2e-fake-sl-pass",
        /SportLots wouldn't let us in the door/,
      );

      await seedAndOpen(page, "sportlots", sl);
      await testStoredSession(page, sl, /SportLots account authenticated successfully/i);

      await page.goto("/profile/credentials");
      await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
        timeout: LIVE,
      });
      await selectSite(page, sl);
      await clearConnection(page, sl);
      await expect(page.getByLabel(/SportLots Username/)).toBeVisible();
    } else {
      await page.goto("/testing/seed-credentials?sites=sportlots&redirect=/profile/credentials");
      await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
        timeout: LIVE,
      });
      await selectSite(page, sl);
      await expect(page.getByText("SportLots is on pause", { exact: true })).toBeVisible();
      await expect(page.getByText(/^Sign-ins to SportLots are benched for now/)).toBeVisible();
      await expect(page.getByLabel(/SportLots Username/)).toBeHidden();
      await expect(page.getByRole("button", { name: "Connect", exact: true })).toBeHidden();
      await expect(page.getByRole("button", { name: "Test Credentials" })).toBeHidden();
      await expect(page.getByRole("button", { name: "Sign in again" })).toBeHidden();
    }
  },
);
