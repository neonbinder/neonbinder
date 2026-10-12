// Origin: .maestro/flows/profile/sportlots-paused-shows-notice.yaml (Maestro suite retired in NEO-341; see git history)
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test(
  "SportLots on pause — the Profile card and the Set Builder strip say so, and the strip dismisses (NEO-287)",
  { tag: ["@profile", "@credentials"] },
  async ({ page, signIn, env }) => {
    await signIn("/profile/credentials");
    await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({
      timeout: LAUNCH_GATE,
    });
    await page.getByRole("tab", { name: "SportLots" }).click();
    await expect(page.getByRole("heading", { name: "SportLots Credentials" })).toBeVisible();

    const builderReady = page.getByText(/Build set parameters using marketplace APIs/);
    const strip = page.getByText("SportLots is on pause.");
    const dismiss = page.getByRole("button", { name: "Dismiss pause notice" });

    if (!env.SL_PAUSED) {
      // Live: the card offers the real controls and no pause copy anywhere.
      await expect(page.getByRole("button", { name: "Test Credentials" })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText("SportLots is on pause")).toBeHidden();
      await expect(page.getByText("Sign-in paused")).toBeHidden();
      await expect(page.getByText("Test paused")).toBeHidden();

      await page.goto("/admin/set-builder");
      await expect(builderReady).toBeVisible({ timeout: 30_000 });
      await expect(strip).toBeHidden();
      await expect(dismiss).toBeHidden();
    } else {
      await expect(page.getByText("SportLots is on pause", { exact: true })).toBeVisible();
      await expect(page.getByText(/^Sign-ins to SportLots are benched for now/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Test Credentials" })).toBeHidden();
      await expect(page.getByRole("button", { name: "Sign in again" })).toBeHidden();
      await expect(page.getByLabel(/SportLots Username/)).toBeHidden();

      await page.goto("/admin/set-builder");
      await expect(builderReady).toBeVisible({ timeout: 30_000 });
      // A paused platform is not required: no credentials gate.
      await expect(page.getByText("Set Builder requires marketplace credentials")).toBeHidden();
      await expect(strip).toBeVisible();
      await expect(
        page.getByText(
          /Syncs roll on with BuySportsCards only\. Your SportLots links stay put — nothing gets unlinked\./,
        ),
      ).toBeVisible();

      await expect(dismiss).toBeVisible();
      await dismiss.click();
      await expect(strip).toBeHidden();
      await expect(dismiss).toBeHidden();
      await expect(builderReady).toBeVisible();
    }
  },
);
