// Origin: .maestro/flows/profile/session-expired-prompts-sign-in-again.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Expired marketplace session — the panel says sign in again, and goes back to connected once the session proves good",
  { tag: ["@credentials", "@profile"] },
  async ({ page, signIn, env }) => {
    await signIn("/profile/credentials");
    await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible({
      timeout: LAUNCH_GATE,
    });

    const openSportLotsTab = async () => {
      const tab = page.getByRole("tab", { name: "SportLots" });
      await expect(tab).toBeVisible({ timeout: 10_000 });
      await tab.click();
      await expect(page.getByText(/SportLots Credentials/)).toBeVisible();
    };

    if (!env.SL_PAUSED) {
      // Seed a good stored SportLots session; the panel reads "connected".
      await page.goto("/testing/seed-credentials?sites=sportlots&redirect=/profile/credentials");
      await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible({
        timeout: 90_000,
      });
      await openSportLotsTab();
      await expect(page.getByText(/Connected to SportLots/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Test Credentials" })).toBeVisible();

      // Expire the session: the panel says to sign in again and offers none of
      // the connected controls.
      await page.goto("/testing/needs-reauth?site=sportlots&redirect=/profile/credentials");
      await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await openSportLotsTab();
      await expect(page.getByText(/Sign in to SportLots again/)).toBeVisible();
      await expectAccessible(page, { label: "Profile, SportLots session expired" });
      await expect(page.getByRole("button", { name: "Test Credentials" })).toBeHidden();
      await expect(page.getByLabel(/SportLots Username/)).toBeHidden();

      // Signing in again opens the form; a good stored session proves itself.
      await page.getByRole("button", { name: "Sign in again" }).click();
      await expect(page.getByLabel(/SportLots Username/)).toBeVisible();
      await expectAccessible(page, { label: "Profile, SportLots sign-in form" });
      await page.getByRole("button", { name: "Test Stored Credentials" }).click();
      await expect(page.getByText(/SportLots account authenticated successfully/i)).toBeVisible({
        timeout: 30_000,
      });

      // Cancelling returns the panel to connected.
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByText(/Connected to SportLots/)).toBeVisible();
    } else {
      // SportLots paused: the panel says so before and after the expiry, and
      // never offers a sign-in.
      const paused = page.getByText("SportLots is on pause", { exact: true });
      await page.goto("/testing/seed-credentials?sites=sportlots&redirect=/profile/credentials");
      await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await openSportLotsTab();
      await expect(paused).toBeVisible();
      await expect(page.getByRole("button", { name: "Test Credentials" })).toBeHidden();

      await page.goto("/testing/needs-reauth?site=sportlots&redirect=/profile/credentials");
      await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
      await openSportLotsTab();
      await expect(paused).toBeVisible();
      await expect(page.getByText(/^Sign-ins to SportLots are benched for now/)).toBeVisible();
      await expectAccessible(page, { label: "Profile, SportLots paused" });
      await expect(page.getByText(/Sign in to SportLots again/)).toBeHidden();
      await expect(page.getByRole("button", { name: "Sign in again" })).toBeHidden();
      await expect(page.getByRole("button", { name: "Test Credentials" })).toBeHidden();
      await expect(page.getByLabel(/SportLots Username/)).toBeHidden();
    }
  },
);
