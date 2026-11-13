// R1: a collector's open scan shows in the signed-in dashboard's In the Hopper,
// as a block for its run, and the block's link finishes it on the Add cards tab
// of the run it came from (NEO-464, NEO-539). The scan is seeded, not produced: a read pair that nothing
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
  "Dashboard hopper: an open scan shows as a run to finish and its link opens that run on Collection",
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

    // The seeded scan has no best guess, so it waits to be identified: the lead line says so, and
    // the run's block names its binder and the screen that finishes it (NEO-539).
    const hopper = page.getByRole("region", { name: "In the Hopper" });
    await expect(hopper.getByText("1 scan to identify", { exact: true })).toBeVisible();
    const block = hopper
      .getByRole("list", { name: "Runs to finish", exact: true })
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { level: 3, name: "Main on Collection", exact: true }) });
    await expect(block).toBeVisible();
    await expect(block.getByText("1 to identify", { exact: true })).toBeVisible();
    // No "N of M done" progress is left on the dashboard.
    await expect(page.getByText(/\d+ of \d+ scans? done/)).toHaveCount(0);
    await expectAccessible(page, { label: "Dashboard with a scan in the hopper" });

    // The run is in Main, a binder, so it is finished on Collection.
    const run = block.getByRole("link", { name: "Finish this run into Main on Collection", exact: true });
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
