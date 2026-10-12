// Origin: .maestro/flows/set-selector/admin-missing-bsc-shows-warning.yaml (Maestro suite retired in NEO-341; see git history)
// Dedicated admin-sl-only account: only SportLots is seeded, so the gate
// names BuySportsCards alone.
import { test, expect, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Set Builder Gate — admin without BSC credentials sees the warning banner",
  { tag: ["@set-selector"] },
  async ({ page, signIn, env }) => {
    await signIn("/set-selector", { account: "admin-sl-only" });
    const banner = page.getByRole("alert").filter({
      has: page.getByRole("heading", { name: "Set Builder requires marketplace credentials" }),
    });
    await expect(banner).toBeVisible({ timeout: LAUNCH_GATE });

    // NEO-141: seeding is a live marketplace round trip when the stored
    // session cannot be renewed (the flow's 90 s); the seed page forwards
    // back to /set-selector when it is done.
    await page.goto("/testing/seed-credentials?sites=sportlots&redirect=/set-selector");
    await expect(banner).toBeVisible({ timeout: 90_000 });

    // The missing platform is named, the present one is not.
    await expect(banner.getByText("BuySportsCards", { exact: true })).toBeVisible();
    await expect(page.getByText("SportLots")).toBeHidden();
    await expect(page.getByText("Build set parameters using marketplace APIs")).toBeHidden();

    // NEO-287: the pause strip belongs to the panel this account cannot open.
    if (env.SL_PAUSED) {
      await expect(page.getByText(/SportLots is on pause\./)).toBeHidden();
      await expect(page.getByRole("button", { name: "Dismiss pause notice" })).toBeHidden();
    }

    await banner.getByRole("link", { name: "Configure credentials in Profile" }).click();
    await expect(page.getByText("Profile Settings", { exact: true })).toBeVisible();
  },
);
