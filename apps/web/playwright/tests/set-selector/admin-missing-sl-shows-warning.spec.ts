// Origin: .maestro/flows/set-selector/admin-missing-sl-shows-warning.yaml (Maestro suite retired in NEO-341; see git history)
// Dedicated admin-bsc-only account: only BuySportsCards is seeded. With
// SportLots live the gate names SportLots alone; under the NEO-287 pause a
// paused platform is not required, so the Set Builder opens.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Set Builder Gate — admin without SportLots credentials sees the warning banner",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector", { account: "admin-bsc-only" });

    const banner = page.getByRole("alert").filter({
      has: page.getByRole("heading", { name: "Set Builder requires marketplace credentials" }),
    });
    const panel = page.getByText("Build set parameters using marketplace APIs");

    if (!env.SL_PAUSED) {
      await expect(banner).toBeVisible({ timeout: LAUNCH_GATE });

      // The seed hop is a live marketplace round trip (the flow's 90 s).
      await page.goto("/testing/seed-credentials?sites=buysportscards&redirect=/set-selector");
      await expect(banner).toBeVisible({ timeout: 90_000 });

      await expect(banner.getByText("SportLots", { exact: true })).toBeVisible();
      await expect(page.getByText("BuySportsCards")).toBeHidden();
      await expect(panel).toBeHidden();
      await expectAccessible(page, { label: "Set Builder credentials gate (SportLots missing)" });

      await banner.getByRole("link", { name: "Configure credentials in Profile" }).click();
      await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible();
      await expectAccessible(page, { label: "Profile settings" });
    } else {
      await expect(banner.or(panel)).toBeVisible({ timeout: LAUNCH_GATE });

      await page.goto("/testing/seed-credentials?sites=buysportscards&redirect=/set-selector");
      await expect(panel).toBeVisible({ timeout: 90_000 });
      await expect(banner).toBeHidden();

      await expect(page.getByText(/SportLots is on pause\./)).toBeVisible();
      await expect(
        page.getByText(/Syncs roll on with BuySportsCards only\. Your SportLots links stay put — nothing gets unlinked\./),
      ).toBeVisible();
      await expectAccessible(page, { label: "Set Builder with the SportLots pause strip" });
    }
  },
);
