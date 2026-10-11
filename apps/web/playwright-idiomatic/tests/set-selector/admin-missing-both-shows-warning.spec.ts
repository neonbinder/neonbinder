// Spec: .maestro/flows/set-selector/admin-missing-both-shows-warning.yaml
// Dedicated never-seeded account (admin-no-credentials): sign in and assert,
// nothing is written.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Set Builder Gate — admin with neither BSC nor SportLots credentials sees the warning banner",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector", { account: "admin-no-credentials" });

    const banner = page.getByRole("alert").filter({
      has: page.getByRole("heading", { name: "Set Builder requires marketplace credentials" }),
    });
    await expect(banner).toBeVisible({ timeout: LAUNCH_GATE });

    // NEO-287: a paused platform is not required, so the banner names only
    // what this account must still connect.
    if (!env.SL_PAUSED) {
      await expect(banner).toContainText("BuySportsCards and SportLots");
    } else {
      await expect(banner).toContainText("You need to connect");
      await expect(banner.getByText("BuySportsCards", { exact: true })).toBeVisible();
      await expect(banner).not.toContainText("SportLots");
    }

    // The gate replaces the builder: neither the panel nor its sync controls render.
    await expect(page.getByText("Build set parameters using marketplace APIs")).toBeHidden();
    await expect(page.getByRole("button", { name: "Sync Sports" })).toBeHidden();

    // The CTA lands on the profile.
    await banner.getByRole("link", { name: "Configure credentials in Profile" }).click();
    await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible();
  },
);
