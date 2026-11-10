// R1: a collector's open scan shows in the signed-in dashboard's In the Hopper,
// and the run's link finishes it on the Add cards tab of the run it came from
// (NEO-464). The scan is seeded, not produced: a read pair that nothing
// identified costs a real photo, the preprocess models and minutes
// (/testing/seed-placeholder-run?hopperScan=1, `seedMyTestHopperRun`), and the
// property under test is the dashboard's link, not the reading.
//
// R7: writes only this account's own run, homed in Main (the seed cancels the
// account's open runs first, for the active-run cap) and leaves it for the idle
// sweep; the seed also sets aside the account's earlier open scans, so a repeat
// run counts exactly one.
import { test, expect, expectAccessible, LAUNCH_GATE } from "../../support/fixtures";

test(
  "Dashboard hopper: an open scan counts as processing and its run link opens that run on Collection",
  { tag: ["@smoke", "@dashboard"] },
  async ({ page, signIn }) => {
    // The seed lands on the run's Add cards screen; the run id is in its URL.
    await signIn("/testing/seed-placeholder-run%3FhopperScan%3D1");
    await expect(page).toHaveURL(/\/collection\?tab=add&run=\w+/, { timeout: LAUNCH_GATE });
    const runUrl = page.url();
    const runId = new URL(runUrl).searchParams.get("run")!;

    // Home, to the dashboard: the greeting is the gate.
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { level: 1, name: "Welcome back, slugger." })).toBeVisible({ timeout: LAUNCH_GATE });

    const hopper = page.getByRole("region", { name: "In the Hopper" });
    await expect(hopper.getByRole("heading", { level: 3, name: "1 scan processing", exact: true })).toBeVisible();
    await expectAccessible(page, { label: "Dashboard with a scan in the hopper" });

    // The run is in Main, a binder, so it is finished on Collection.
    const run = hopper.getByRole("link", { name: /^Main 0 of 1 scan done Finish on Collection$/ });
    await run.click();
    await expect(page).toHaveURL(new RegExp(`/collection\\?tab=add&run=${runId}$`));
    // The run screen shows: its workspace carries a Pairing column, which the tab shows only for an open run.
    await expect(page.getByRole("region", { name: /^Pairing, \d+$/ })).toBeVisible();

    // Back comes home, to the dashboard with its hopper.
    await page.goBack();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(hopper).toBeVisible();
  },
);
