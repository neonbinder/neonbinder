// Spec: .maestro/flows/set-selector/reauth-notice-on-set-builder.yaml
// NEO-278: a lapsed marketplace session shows a notice on the Set Builder whose
// link lands on the credentials page and whose Dismiss hides it. While
// SportLots is paused the strip is the pause notice instead, never the
// re-auth one.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";
import { setBuilderReady } from "../../support/set-builder";

test(
  "Lapsed marketplace session — the Set Builder says so, its link lands on the credentials page, and Dismiss hides it (NEO-278)",
  { tag: ["@credentials", "@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/admin/set-builder");
    await expect(setBuilderReady(page)).toBeVisible({ timeout: LAUNCH_GATE });

    const ranOut = page.getByText(/sessions? ran out/);
    const notice = page.getByText("Your SportLots session ran out.");

    if (!env.SL_PAUSED) {
      // Healthy account: no lapsed-session strip.
      await expect(ranOut).toBeHidden();

      // Flag the SportLots session as lapsed (the product's own fixture hop).
      await page.goto("/testing/needs-reauth?site=sportlots&redirect=/admin/set-builder");
      await expect(setBuilderReady(page)).toBeVisible({ timeout: 30_000 });
      await expect(notice).toBeVisible();
      await expect(
        page.getByText(/Syncs are running on borrowed time\. Sign in again to keep them rolling\./),
      ).toBeVisible();
      const signInAgain = page.getByRole("link", { name: "Sign in again on your Profile →" });
      await expect(signInAgain).toBeVisible();
      await expect(page.getByRole("button", { name: "Dismiss sign-in notice" })).toBeVisible();

      // The link lands on the credentials page.
      await signInAgain.click();
      await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible();
      await expect(page.getByText(/BuySportsCards Credentials/).first()).toBeVisible();

      // The notice survives a reload until it is dismissed.
      await page.goto("/admin/set-builder");
      await expect(setBuilderReady(page)).toBeVisible({ timeout: 30_000 });
      await expect(notice).toBeVisible();

      await page.getByRole("button", { name: "Dismiss sign-in notice" }).click();
      await expect(notice).toBeHidden();
      await expect(setBuilderReady(page)).toBeVisible();

      // Restore the worker's SportLots credentials for later flows.
      await page.goto("/testing/seed-credentials?sites=sportlots&redirect=/profile/credentials");
      await expect(page.getByRole("heading", { name: "Profile Settings" })).toBeVisible({ timeout: 90_000 });
      const slTab = page.getByRole("tab", { name: "SportLots" });
      await expect(slTab).toBeVisible();
      await slTab.click();
      await expect(page.getByText(/SportLots Credentials/).first()).toBeVisible();
      await expect(page.getByText(/Connected to SportLots/)).toBeVisible();
    } else {
      // Paused: the strip is the pause notice, and a lapsed flag never shows.
      await expect(page.getByText("SportLots is on pause.")).toBeVisible();
      await expect(ranOut).toBeHidden();

      await page.goto("/testing/needs-reauth?site=sportlots&redirect=/admin/set-builder");
      await expect(setBuilderReady(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText("SportLots is on pause.")).toBeVisible();
      await expect(
        page.getByText(/Syncs roll on with BuySportsCards only\. Your SportLots links stay put — nothing gets unlinked\./),
      ).toBeVisible();
      await expect(notice).toBeHidden();
      await expect(ranOut).toBeHidden();
      await expect(page.getByRole("button", { name: "Dismiss sign-in notice" })).toBeHidden();
    }
  },
);
