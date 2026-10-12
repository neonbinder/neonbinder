// Spec: .maestro/flows/profile/test-credentials.yaml
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

const LIVE = 30_000; // live marketplace round trip

test("Test BSC and SportLots Credentials", { tag: ["@credentials", "@profile"] }, async ({ page, signIn, env }) => {
  await signIn("/profile/credentials");
  await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
    timeout: LAUNCH_GATE,
  });

  // BuySportsCards is the default tab.
  await expect(page.getByRole("heading", { name: "BuySportsCards Credentials" })).toBeVisible({
    timeout: LIVE,
  });
  await expect(page.getByText("Connected to BuySportsCards")).toBeVisible();
  const testButton = page.getByRole("button", { name: "Test Credentials" });
  await expect(testButton).toBeVisible({ timeout: LIVE });
  await testButton.click();
  await expect(page.getByText(/BSC account authenticated successfully/)).toBeVisible({
    timeout: LIVE,
  });

  await page.getByRole("tab", { name: "SportLots" }).click();
  await expect(page.getByRole("heading", { name: "SportLots Credentials" })).toBeVisible({
    timeout: 10_000,
  });

  if (!env.SL_PAUSED) {
    await expect(page.getByText("Connected to SportLots")).toBeVisible();
    await expect(testButton).toBeVisible({ timeout: LIVE });
    await testButton.click();
    await expect(page.getByText(/Sportlots account authenticated successfully/i)).toBeVisible({
      timeout: LIVE,
    });
  } else {
    await expect(page.getByText("SportLots is on pause", { exact: true })).toBeVisible();
    await expect(page.getByText(/^Sign-ins to SportLots are benched for now/)).toBeVisible();
    await expect(testButton).toBeHidden();
    await expect(page.getByRole("button", { name: "Sign in again" })).toBeHidden();
  }
});
